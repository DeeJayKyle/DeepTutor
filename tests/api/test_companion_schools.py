"""School workspaces: membership, shared classes and per-class role enforcement."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from deeptutor.api.routers import companion_schools as schools
from deeptutor.multi_user.context import reset_current_user, set_current_user
from deeptutor.multi_user.models import CurrentUser
from deeptutor.multi_user.paths import admin_scope


class _Users:
    """Switch the signed-in user between requests."""

    name = "alice"


@pytest.fixture
def client(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("COMPANION_SCHOOLS_DB", str(tmp_path / "schools.sqlite3"))
    monkeypatch.setattr(schools, "_username", lambda: _Users.name)
    monkeypatch.setattr(
        schools, "_account_exists", lambda name: name in {"alice", "bob", "carol", "dave", "eve"}
    )
    app = FastAPI()
    app.include_router(schools.router, prefix="/api/companion/schools")
    with TestClient(app) as c:
        yield c


def as_user(name: str) -> None:
    _Users.name = name


def bundle(name="Pharmacy Y1", **sections):
    base = {
        "class": {"id": "c1", "name": name},
        "units": [{"id": "u1", "title": "Pharmacology I"}],
        "materials": [],
        "resources": [],
        "research": [],
        "students": [{"id": "s1", "firstName": "Amina"}],
        "assessments": [{"id": "a1", "title": "CAT 1", "maxScore": 30}],
        "marks": [],
    }
    base.update(sections)
    return base


def setup_school(client):
    as_user("alice")
    school = client.post("/api/companion/schools", json={"name": "Kenya Medical College"}).json()
    sid = school["id"]
    for user, role in [("bob", "tutor"), ("carol", "tutor"), ("dave", "tutor")]:
        assert (
            client.post(
                f"/api/companion/schools/{sid}/members", json={"username": user, "role": role}
            ).status_code
            == 200
        )
    as_user("bob")
    created = client.post(
        f"/api/companion/schools/{sid}/classes", json={"id": "class_pharm_1", "bundle": bundle()}
    )
    assert created.status_code == 201, created.text
    cid = created.json()["id"]
    client.put(
        f"/api/companion/schools/{sid}/classes/{cid}/roles",
        json={"username": "carol", "role": "assistant"},
    )
    client.put(
        f"/api/companion/schools/{sid}/classes/{cid}/roles",
        json={"username": "dave", "role": "viewer"},
    )
    return sid, cid


def test_changed_sections_detects_record_changes():
    old = bundle()
    assert schools.changed_sections(old, bundle()) == []
    new = bundle(marks=[{"id": "a1|s1", "score": 20}])
    assert schools.changed_sections(old, new) == ["marks"]
    assert schools.changed_sections(old, bundle(name="Renamed")) == ["class"]


def test_membership_and_visibility(client):
    sid, cid = setup_school(client)
    as_user("eve")  # not a member
    assert client.get(f"/api/companion/schools/{sid}").status_code == 404
    assert client.get(f"/api/companion/schools/{sid}/classes/{cid}").status_code == 404
    assert client.get("/api/companion/schools").json()["schools"] == []

    as_user("alice")  # admin sees every class and acts as lead
    detail = client.get(f"/api/companion/schools/{sid}").json()
    assert detail["my_role"] == "admin"
    assert [c["my_role"] for c in detail["classes"]] == ["lead"]

    as_user("carol")
    detail = client.get(f"/api/companion/schools/{sid}").json()
    assert [c["my_role"] for c in detail["classes"]] == ["assistant"]
    # Tutors cannot manage membership.
    assert (
        client.post(f"/api/companion/schools/{sid}/members", json={"username": "eve"}).status_code
        == 403
    )


def test_role_permissions_are_enforced_on_the_server(client):
    sid, cid = setup_school(client)
    url = f"/api/companion/schools/{sid}/classes/{cid}"

    as_user("carol")  # assistant: marks only
    record = client.get(url).json()
    denied = client.put(url, json={"base_rev": record["rev"], "bundle": bundle(students=[])})
    assert denied.status_code == 403
    assert "students" in denied.json()["detail"]
    ok = client.put(
        url,
        json={
            "base_rev": record["rev"],
            "bundle": bundle(
                marks=[{"id": "a1|s1", "assessmentId": "a1", "studentId": "s1", "score": 24}]
            ),
        },
    )
    assert ok.status_code == 200, ok.text
    assert ok.json() == {"id": cid, "rev": 2, "changed": ["marks"]}

    as_user("dave")  # viewer: read only
    record = client.get(url).json()
    assert record["bundle"]["marks"][0]["score"] == 24
    assert client.put(url, json={"base_rev": record["rev"], "bundle": bundle()}).status_code == 403

    as_user("carol")  # assistant cannot rename or delete or assign roles
    assert client.delete(url).status_code == 403
    assert (
        client.put(f"{url}/roles", json={"username": "dave", "role": "teacher"}).status_code == 403
    )


def test_stale_revision_returns_conflict_with_current_bundle(client):
    sid, cid = setup_school(client)
    url = f"/api/companion/schools/{sid}/classes/{cid}"
    as_user("bob")
    first = client.put(
        url,
        json={
            "base_rev": 1,
            "bundle": bundle(units=[{"id": "u1", "title": "Pharmacology I (revised)"}]),
        },
    )
    assert first.status_code == 200
    stale = client.put(url, json={"base_rev": 1, "bundle": bundle(units=[])})
    assert stale.status_code == 409
    detail = stale.json()["detail"]
    assert detail["rev"] == 2
    assert detail["bundle"]["units"][0]["title"] == "Pharmacology I (revised)"


def test_admin_rules_and_report(client):
    sid, cid = setup_school(client)
    as_user("alice")
    # The only admin cannot be demoted or removed.
    assert (
        client.post(
            f"/api/companion/schools/{sid}/members", json={"username": "alice", "role": "tutor"}
        ).status_code
        == 400
    )
    assert client.delete(f"/api/companion/schools/{sid}/members/alice").status_code == 400
    assert (
        client.post(
            f"/api/companion/schools/{sid}/members", json={"username": "nobody"}
        ).status_code
        == 404
    )
    report = client.get(f"/api/companion/schools/{sid}/report").json()
    assert report["classes"][0]["bundle"]["class"]["name"] == "Pharmacy Y1"
    assert any(
        e["action"] == "publish-class"
        for e in client.get(f"/api/companion/schools/{sid}/audit").json()["entries"]
    )
    # Removing a member also removes their class roles.
    assert client.delete(f"/api/companion/schools/{sid}/members/carol").status_code == 200
    as_user("carol")
    assert client.get(f"/api/companion/schools/{sid}/classes/{cid}").status_code == 404
    as_user("bob")
    assert client.get(f"/api/companion/schools/{sid}/report").status_code == 403


def test_invalid_input(client):
    as_user("alice")
    sid = client.post("/api/companion/schools", json={"name": "School"}).json()["id"]
    bad = client.post(
        f"/api/companion/schools/{sid}/classes", json={"bundle": {"class": {"name": ""}}}
    )
    assert bad.status_code == 400
    assert client.get("/api/companion/schools/..%2F..").status_code in {400, 404}


def test_real_user_context_is_used(monkeypatch, tmp_path):
    monkeypatch.setenv("COMPANION_SCHOOLS_DB", str(tmp_path / "s.sqlite3"))
    user = CurrentUser(id="u-1", username="frank", role="user", scope=admin_scope())
    token = set_current_user(user)
    try:
        assert schools._username() == "frank"
    finally:
        reset_current_user(token)
