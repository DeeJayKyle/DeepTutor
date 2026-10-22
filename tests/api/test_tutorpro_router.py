"""Deep Tutor Pro router tests, driven through a real ASGI client."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from deeptutor.api.routers import tutorpro
from deeptutor.services.path_service import PathService


@pytest.fixture
def client(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("DEEPTUTOR_HOME", str(tmp_path))
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    PathService.reset_instance()

    class _Paths:
        def get_user_root(self) -> Path:
            return tmp_path / "user"

    # Keep the sync store inside the test's folder whatever path scope is active.
    monkeypatch.setattr(tutorpro, "get_current_path_service", lambda: _Paths())
    app = FastAPI()
    app.include_router(tutorpro.public_router, prefix="/api/tutorpro")
    app.include_router(tutorpro.router, prefix="/api/tutorpro")
    with TestClient(app) as test_client:
        yield test_client
    PathService.reset_instance()


@pytest.fixture
def fake_llm(monkeypatch):
    """Replace the provider call; record the bodies it received."""
    calls: list[tuple[str, dict]] = []
    replies: list[str] = []

    async def fake_post(provider: str, body: dict) -> dict:
        calls.append((provider, body))
        return {"choices": [{"message": {"content": replies.pop(0) if replies else "ok"}}]}

    monkeypatch.setattr(tutorpro, "_post_chat", fake_post)
    return calls, replies


def test_provider_resolution_prefers_openai_and_honours_explicit_choice(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert tutorpro.resolve_provider("auto") is None
    monkeypatch.setenv("GEMINI_API_KEY", "g")
    assert tutorpro.resolve_provider("auto") == "gemini"
    assert tutorpro.resolve_provider("openai") == "gemini"  # unavailable → fallback
    monkeypatch.setenv("OPENAI_API_KEY", "o")
    assert tutorpro.resolve_provider("auto") == "openai"
    assert tutorpro.resolve_provider("gemini") == "gemini"
    monkeypatch.setenv("TUTORPRO_GEMINI_MODEL", "gemini-2.5-pro")
    assert tutorpro.provider_model("gemini") == "gemini-2.5-pro"


def test_parse_json_reply_tolerates_fences_and_prose():
    assert tutorpro.parse_json_reply('```json\n{"a": 1}\n```') == {"a": 1}
    assert tutorpro.parse_json_reply('Here it is: {"a": [1, 2]} hope it helps') == {"a": [1, 2]}
    with pytest.raises(Exception):
        tutorpro.parse_json_reply('{"a": [1, 2')


def test_normalize_outline_cleans_units_and_builds_classes():
    data = {
        "programme": {"title": "Diploma in Pharmacy", "duration_years": "3 years"},
        "units": [
            {
                "code": "PHA 111",
                "title": "Pharmaceutics I",
                "year": "1",
                "semester": 1,
                "lecture_hours": "45",
                "practical_hours": 30,
            },
            {"code": "PHA 111", "title": "Duplicate", "year": 1},
            {"code": "", "title": ""},
            {"code": "PHA 211", "title": "Pharmacology II", "year": 2, "total_hours": "60 hours"},
            "nonsense",
        ],
    }
    out = tutorpro.normalize_outline(data)
    assert [u["code"] for u in out["units"]] == ["PHA 111", "PHA 211"]
    assert out["units"][0]["total_hours"] == 75
    assert out["units"][1]["total_hours"] == 60
    assert out["programme"]["duration_years"] == 3
    assert [c["year"] for c in out["classes"]] == [1, 2, 3]
    assert out["programme"]["total_hours"] == 135


def test_normalize_unit_detail_estimates_missing_hours():
    out = tutorpro.normalize_unit_detail(
        {"topics": [{"title": "Intro", "hours": 4}, {"title": "Absorption"}, "Excretion"]},
        unit_total_hours=10,
    )
    assert [t["hours"] for t in out["topics"]] == [4, 3, 3]
    assert out["hours_estimated"] is True


def test_normalize_paper_fixes_answers_and_counts_choose_sections():
    data = {
        "title": "Pharmacology I",
        "sections": [
            {
                "title": "Section A",
                "type": "multiple choice",
                "questions": [
                    {
                        "prompt": "Which drug is a beta blocker?",
                        "options": ["Atenolol", "Insulin"],
                        "answer": "A",
                        "marks": 1,
                    },
                    {"prompt": "No options MCQ", "type": "mcq", "marks": 1},
                ],
            },
            {
                "title": "Section C",
                "type": "long essay",
                "choose": 2,
                "questions": [
                    {"prompt": f"Essay {i}", "marking_points": [{"point": "x", "marks": 10}, "y"]}
                    for i in range(3)
                ],
            },
            {"title": "Empty", "questions": []},
        ],
    }
    paper = tutorpro.normalize_paper(data)
    assert [s["title"] for s in paper["sections"]] == ["Section A", "Section C"]
    mcq = paper["sections"][0]["questions"][0]
    assert mcq["answer_index"] == 0 and mcq["answer"] == "A. Atenolol"
    assert paper["sections"][1]["type"] == "essay"
    assert paper["sections"][1]["questions"][0]["marks"] == 11
    # Section A: 1 + 1, Section C: best 2 of 3 essays (11 each).
    assert paper["total_marks"] == 24


def test_normalize_format_drops_empty_sections():
    out = tutorpro.normalize_format(
        {
            "sections": [
                {"type": "MCQ", "count": "40", "marks_each": 1},
                {"type": "essay", "count": 0},
            ]
        }
    )
    assert out["sections"] == [
        {
            "title": "Section A",
            "type": "mcq",
            "count": 40,
            "marks_each": 1.0,
            "choose": 0,
            "instructions": "",
        }
    ]


def test_notes_prompt_is_organised_by_contact_hours_with_sources():
    req = tutorpro.NotesRequest(
        programme="Diploma in Pharmacy",
        unit=tutorpro.UnitContext(code="PHA 111", title="Pharmacology I", year=1),
        topic=tutorpro.TopicContext(title="Pharmacokinetics", hours=4, objectives=["Define ADME"]),
        hour_start=9,
        sources=[tutorpro.SourceText(id="S1", title="Rang & Dale", text="Absorption is ...")],
    )
    prompt = tutorpro.build_notes_prompt(req)
    assert "unit hours 9–12" in prompt
    assert "Contact hour N" in prompt
    assert "- Define ADME" in prompt
    assert "--- S1: Rang & Dale ---" in prompt


def test_assessment_prompt_lists_sections_and_total():
    req = tutorpro.AssessmentRequest(
        unit=tutorpro.UnitContext(code="PHA 111", title="Pharmacology I"),
        topics=[tutorpro.TopicContext(title="Pharmacokinetics", hours=6)],
        sections=[
            tutorpro.FormatSection(title="Section A", type="mcq", count=20, marks_each=1),
            tutorpro.FormatSection(
                title="Section C", type="essay", count=3, marks_each=20, choose=2
            ),
        ],
        style_notes="Use 'Describe' and 'Explain'.",
    )
    prompt = tutorpro.build_assessment_prompt(req)
    assert "Total marks: 60" in prompt
    assert "candidates answer any 2" in prompt
    assert "Pharmacokinetics (6 h)" in prompt
    assert "Use 'Describe'" in prompt


def test_ping_and_status_are_reachable(client):
    assert client.get("/api/tutorpro/ping").json()["app"] == "deep-tutor-pro"
    status = client.get("/api/tutorpro/status").json()
    assert status["default_provider"] == "gemini"
    assert status["providers"][0]["id"] == "gemini"


def test_login_returns_bearer_token(client, monkeypatch):
    from deeptutor.services import auth

    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth, "POCKETBASE_ENABLED", False)
    monkeypatch.setattr(
        auth,
        "authenticate",
        lambda u, p: (
            auth.TokenPayload(username=u, role="admin", user_id="u1") if p == "pw" else None
        ),
    )
    monkeypatch.setattr(auth, "create_token", lambda u, r, i: f"token-{u}-{r}")
    assert (
        client.post(
            "/api/tutorpro/auth/login", json={"username": "kyle", "password": "no"}
        ).status_code
        == 401
    )
    body = client.post(
        "/api/tutorpro/auth/login", json={"username": "kyle", "password": "pw"}
    ).json()
    assert body["token"] == "token-kyle-admin" and body["auth"] is True


def test_curriculum_outline_and_unit_endpoints(client, fake_llm):
    calls, replies = fake_llm
    replies.append(
        json.dumps(
            {
                "programme": {"title": "Certificate in Pharmacy", "duration_years": 2},
                "units": [{"code": "CP 101", "title": "Dispensing", "year": 1, "total_hours": 40}],
            }
        )
    )
    res = client.post("/api/tutorpro/curriculum/outline", json={"text": "CURRICULUM " * 10})
    assert res.status_code == 200, res.text
    assert res.json()["units"][0]["code"] == "CP 101"
    assert calls[0][0] == "gemini"
    assert calls[0][1]["response_format"] == {"type": "json_object"}

    replies.append(
        "```json\n" + json.dumps({"topics": [{"title": "Prescriptions", "hours": 6}]}) + "\n```"
    )
    res = client.post(
        "/api/tutorpro/curriculum/unit",
        json={
            "unit": {"title": "Dispensing", "total_hours": 40},
            "text": "Unit text",
            "provider": "openai",
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["topics"][0]["hours"] == 6


def test_outline_without_units_is_a_clear_error(client, fake_llm):
    _, replies = fake_llm
    replies.append(json.dumps({"programme": {"title": "Nothing"}, "units": []}))
    res = client.post("/api/tutorpro/curriculum/outline", json={"text": "x" * 50})
    assert res.status_code == 422
    assert "No course units" in res.json()["detail"]


def test_assessment_and_questions_endpoints(client, fake_llm):
    _, replies = fake_llm
    replies.append(
        json.dumps(
            {
                "sections": [
                    {
                        "type": "short",
                        "questions": [
                            {
                                "prompt": "Define bioavailability.",
                                "marks": 2,
                                "solution": "Fraction reaching circulation.",
                            }
                        ],
                    }
                ]
            }
        )
    )
    body = {
        "unit": {"title": "Pharmacology"},
        "topics": [{"title": "Pharmacokinetics"}],
        "sections": [{"type": "short", "count": 1, "marks_each": 2}],
    }
    res = client.post("/api/tutorpro/assessment", json=body)
    assert res.status_code == 200, res.text
    assert res.json()["total_marks"] == 2

    replies.append(json.dumps({"questions": [{"prompt": "Q1", "type": "essay", "marks": 10}]}))
    res = client.post(
        "/api/tutorpro/questions",
        json={"unit": {"title": "Pharmacology"}, "topic": {"title": "Receptors"}, "count": 1},
    )
    assert res.json()["questions"][0]["topic"] == "Receptors"


def test_solve_sends_images_as_multimodal_parts(client, fake_llm):
    calls, replies = fake_llm
    replies.append("**Final answer:** 42")
    image = "data:image/png;base64,iVBORw0KGgo="
    res = client.post(
        "/api/tutorpro/solve",
        json={
            "images": [image],
            "history": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello"},
            ],
        },
    )
    assert res.status_code == 200, res.text
    messages = calls[0][1]["messages"]
    assert messages[0]["role"] == "system" and "Deep Solve" in messages[0]["content"]
    assert messages[-1]["content"][1] == {"type": "image_url", "image_url": {"url": image}}
    assert client.post("/api/tutorpro/solve", json={"text": ""}).status_code == 400
    bad = client.post("/api/tutorpro/solve", json={"images": ["data:text/html;base64,AAAA"]})
    assert bad.status_code == 400


def test_transcribe_requires_wav_and_uses_gemini_audio(client, fake_llm):
    import base64

    calls, replies = fake_llm
    replies.append("What is pharmacodynamics?")
    wav = base64.b64encode(b"RIFF" + b"\0" * 40).decode()
    res = client.post("/api/tutorpro/transcribe", json={"audio": wav})
    assert res.json()["text"] == "What is pharmacodynamics?"
    assert calls[0][1]["messages"][0]["content"][1]["type"] == "input_audio"
    mp3 = base64.b64encode(b"ID3" + b"\0" * 40).decode()
    assert client.post("/api/tutorpro/transcribe", json={"audio": mp3}).status_code == 400


def _sync_body(data: dict, base_rev: int, **extra) -> dict:
    text = json.dumps(data)
    return {
        "base_rev": base_rev,
        "device": "pc",
        "data": text,
        "sha256": hashlib.sha256(text.encode()).hexdigest(),
        **extra,
    }


def test_sync_versions_conflicts_and_history(client):
    assert client.get("/api/tutorpro/sync/meta").json()["rev"] == 0
    first = client.put("/api/tutorpro/sync", json=_sync_body({"v": 1}, 0))
    assert first.status_code == 200 and first.json()["rev"] == 1
    # A second device still on rev 0 gets a conflict with the cloud copy.
    stale = client.put("/api/tutorpro/sync", json=_sync_body({"v": "phone"}, 0))
    assert stale.status_code == 409
    assert json.loads(stale.json()["detail"]["data"]) == {"v": 1}
    second = client.put("/api/tutorpro/sync", json=_sync_body({"v": 2}, 1))
    assert second.json()["rev"] == 2
    forced = client.put("/api/tutorpro/sync", json=_sync_body({"v": 3}, 0, force=True))
    assert forced.json()["rev"] == 3
    assert json.loads(client.get("/api/tutorpro/sync").json()["data"]) == {"v": 3}
    history = client.get("/api/tutorpro/sync/history").json()["items"]
    assert [h["rev"] for h in history] == [2, 1]
    assert json.loads(client.get("/api/tutorpro/sync/history/1").json()["data"]) == {"v": 1}
    damaged = _sync_body({"v": 4}, 3)
    damaged["sha256"] = "0" * 64
    assert client.put("/api/tutorpro/sync", json=damaged).status_code == 400


@pytest.fixture
def accounts(monkeypatch):
    """Auth switched on with an in-memory user store holding the owner (admin)."""
    from deeptutor.services import auth

    store: dict[str, dict] = {"owner": {"pw": "owner-pass", "role": "admin"}}

    def add_user(username, password, role="user", preset="standard"):
        store[username] = {"pw": password, "role": role if store else "admin"}

    def authenticate(username, password):
        rec = store.get(username)
        if not rec or rec["pw"] != password:
            return None
        return auth.TokenPayload(username=username, role=rec["role"], user_id=f"id-{username}")

    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth, "POCKETBASE_ENABLED", False)
    monkeypatch.setattr(auth, "add_user", add_user)
    monkeypatch.setattr(auth, "authenticate", authenticate)
    monkeypatch.setattr(auth, "delete_user", lambda u: store.pop(u, None) is not None)
    monkeypatch.setattr(auth, "is_first_user", lambda: not store)
    monkeypatch.setattr(
        auth, "list_users", lambda: [{"username": u, "role": r["role"]} for u, r in store.items()]
    )
    monkeypatch.setattr(auth, "create_token", lambda u, r, i: f"token-{u}-{r}")
    monkeypatch.delenv("TUTORPRO_SELF_SIGNUP", raising=False)
    monkeypatch.setattr(tutorpro, "_signups", [])
    return store


def test_tutors_can_create_their_own_account_and_sign_in(client, accounts):
    assert client.get("/api/tutorpro/ping").json()["signup"] is True
    res = client.post(
        "/api/tutorpro/auth/register", json={"username": "amina.n", "password": "longenough"}
    )
    assert res.status_code == 201
    body = res.json()
    assert body["token"] == "token-amina.n-user" and body["role"] == "user"
    assert accounts["amina.n"]["role"] == "user"
    login = client.post(
        "/api/tutorpro/auth/login", json={"username": "amina.n", "password": "longenough"}
    )
    assert login.json()["token"] == "token-amina.n-user"


def test_sign_up_refuses_taken_names_bad_input_and_closed_servers(client, accounts, monkeypatch):
    def reg(username, password="longenough"):
        return client.post(
            "/api/tutorpro/auth/register", json={"username": username, "password": password}
        )

    assert reg("OWNER").status_code == 409  # names are unique ignoring case
    assert reg("ab").status_code == 422
    assert reg("has space").status_code == 422
    assert reg("tutor@school.ac.ke", "short").status_code == 422
    assert reg("tutor@school.ac.ke").status_code == 201

    monkeypatch.setenv("TUTORPRO_SELF_SIGNUP", "0")
    assert client.get("/api/tutorpro/ping").json()["signup"] is False
    assert reg("another").status_code == 403


def test_a_visitor_can_never_become_the_first_administrator(client, accounts):
    accounts.clear()
    res = client.post(
        "/api/tutorpro/auth/register", json={"username": "visitor", "password": "longenough"}
    )
    assert res.status_code == 403
    assert accounts == {}


def test_sign_up_is_rate_limited_per_visitor(client, accounts):
    headers = {"cf-connecting-ip": "203.0.113.9"}
    for i in range(tutorpro.SIGNUP_PER_CLIENT_PER_HOUR):
        assert (
            client.post(
                "/api/tutorpro/auth/register",
                json={"username": f"tutor{i}", "password": "longenough"},
                headers=headers,
            ).status_code
            == 201
        )
    blocked = client.post(
        "/api/tutorpro/auth/register",
        json={"username": "tutor99", "password": "longenough"},
        headers=headers,
    )
    assert blocked.status_code == 429 and "tutor99" not in accounts
    other = client.post(
        "/api/tutorpro/auth/register",
        json={"username": "tutor99", "password": "longenough"},
        headers={"cf-connecting-ip": "198.51.100.4"},
    )
    assert other.status_code == 201
