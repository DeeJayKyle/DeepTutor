"""Tutor Companion school workspaces: schools, members, shared classes, roles.

A tutor's own classes live only on their device. A *school* is an explicit,
opt-in shared space: its members can publish classes to it and the class lead
or a school admin assigns per-class roles. Every write is checked here, on the
server, section by section:

=============  ======================================================
School role    What it allows
=============  ======================================================
``admin``      Manage members, see and manage every class in the school,
               institutional reports. Acts as ``lead`` on its classes.
``tutor``      Publish classes; sees only classes where it holds a role.
=============  ======================================================

=============  ======================================================
Class role     May change
=============  ======================================================
``lead``       Everything, including class details, roles and deletion.
``teacher``    Units, materials, library entries, research, students,
               assessments and marks.
``assistant``  Marks only.
``viewer``     Nothing (read only).
=============  ======================================================

A class is stored as one JSON *bundle* with a revision number. Writers send
the revision they started from; a stale revision returns 409 with the current
bundle so the app can show the differences instead of overwriting them.
Private workspaces are never visible to school admins: only what a member
chooses to publish is stored here.
"""

from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
from typing import Any, Literal
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from deeptutor.api.routers.auth import require_auth

router = APIRouter()

SchoolRole = Literal["admin", "tutor"]
ClassRole = Literal["lead", "teacher", "assistant", "viewer"]

SECTIONS = (
    "class",
    "units",
    "materials",
    "resources",
    "research",
    "students",
    "assessments",
    "marks",
)
SECTION_WRITERS: dict[str, set[str]] = {
    "class": {"lead"},
    "units": {"lead", "teacher"},
    "materials": {"lead", "teacher"},
    "resources": {"lead", "teacher"},
    "research": {"lead", "teacher"},
    "students": {"lead", "teacher"},
    "assessments": {"lead", "teacher"},
    "marks": {"lead", "teacher", "assistant"},
}
MAX_BUNDLE_BYTES = 20 * 1024 * 1024
_ID = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS schools (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (
  school_id TEXT NOT NULL, username TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','tutor')),
  added_by TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (school_id, username));
CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY, school_id TEXT NOT NULL, name TEXT NOT NULL, bundle TEXT NOT NULL,
  rev INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS class_roles (
  class_id TEXT NOT NULL, username TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('lead','teacher','assistant','viewer')),
  PRIMARY KEY (class_id, username));
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, school_id TEXT NOT NULL, class_id TEXT,
  username TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL);
"""


def _db_path() -> Path:
    override = os.environ.get("COMPANION_SCHOOLS_DB", "").strip()
    if override:
        return Path(override)
    from deeptutor.multi_user import paths

    return paths.SYSTEM_ROOT / "companion" / "schools.sqlite3"


def _connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _username() -> str:
    from deeptutor.multi_user.context import get_current_user

    return get_current_user().username


def _check_id(value: str, what: str) -> str:
    if not _ID.match(value or ""):
        raise HTTPException(status_code=400, detail=f"Invalid {what} id.")
    return value


def _audit(
    conn: sqlite3.Connection,
    school_id: str,
    class_id: str | None,
    user: str,
    action: str,
    detail: str = "",
) -> None:
    conn.execute(
        "INSERT INTO audit (school_id, class_id, username, action, detail, at) VALUES (?,?,?,?,?,?)",
        (school_id, class_id, user, action, detail[:300], _now()),
    )


def _member_role(conn: sqlite3.Connection, school_id: str, user: str) -> str | None:
    row = conn.execute(
        "SELECT role FROM members WHERE school_id=? AND username=?", (school_id, user)
    ).fetchone()
    return row["role"] if row else None


def _require_member(conn: sqlite3.Connection, school_id: str, user: str) -> str:
    role = _member_role(conn, school_id, user)
    if role is None:
        # 404 rather than 403: non-members cannot learn that a school exists.
        raise HTTPException(status_code=404, detail="School not found.")
    return role


def _require_admin(conn: sqlite3.Connection, school_id: str, user: str) -> None:
    if _require_member(conn, school_id, user) != "admin":
        raise HTTPException(status_code=403, detail="Only a school admin can do this.")


def _class_row(conn: sqlite3.Connection, school_id: str, class_id: str) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM classes WHERE id=? AND school_id=?", (class_id, school_id)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Class not found.")
    return row


def effective_class_role(
    conn: sqlite3.Connection, school_id: str, class_id: str, user: str
) -> str | None:
    """The user's power over a class: school admins act as lead."""
    school_role = _member_role(conn, school_id, user)
    if school_role is None:
        return None
    if school_role == "admin":
        return "lead"
    row = conn.execute(
        "SELECT role FROM class_roles WHERE class_id=? AND username=?", (class_id, user)
    ).fetchone()
    return row["role"] if row else None


def _require_class_role(conn: sqlite3.Connection, school_id: str, class_id: str, user: str) -> str:
    _require_member(conn, school_id, user)
    _class_row(conn, school_id, class_id)
    role = effective_class_role(conn, school_id, class_id, user)
    if role is None:
        raise HTTPException(status_code=403, detail="You have no role in this class.")
    return role


def _records(value: Any) -> dict[str, str]:
    if isinstance(value, dict):
        return {"__class__": json.dumps(value, sort_keys=True)}
    out: dict[str, str] = {}
    for item in value or []:
        if isinstance(item, dict):
            out[str(item.get("id", ""))] = json.dumps(item, sort_keys=True)
    return out


def changed_sections(old: dict[str, Any], new: dict[str, Any]) -> list[str]:
    """Sections whose records differ between two bundles (pure; unit-tested)."""
    return [s for s in SECTIONS if _records(old.get(s)) != _records(new.get(s))]


def validate_bundle(bundle: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(bundle, dict) or not isinstance(bundle.get("class"), dict):
        raise HTTPException(status_code=400, detail="Class bundle is missing its class details.")
    for section in SECTIONS[1:]:
        value = bundle.get(section, [])
        if not isinstance(value, list) or not all(
            isinstance(r, dict) and r.get("id") for r in value
        ):
            raise HTTPException(
                status_code=400, detail=f"Class bundle section '{section}' is invalid."
            )
    name = str(bundle["class"].get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="The class needs a name.")
    if len(json.dumps(bundle)) > MAX_BUNDLE_BYTES:
        raise HTTPException(status_code=413, detail="This class is larger than 20 MB.")
    return {s: bundle.get(s, {} if s == "class" else []) for s in SECTIONS}


# ---------------------------------------------------------------- models ----


class SchoolCreate(BaseModel):
    name: str = Field(min_length=2, max_length=160)


class MemberUpsert(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    role: SchoolRole = "tutor"


class ClassCreate(BaseModel):
    id: str | None = Field(default=None, max_length=64)
    bundle: dict[str, Any]


class ClassUpdate(BaseModel):
    base_rev: int = Field(ge=0)
    bundle: dict[str, Any]


class RoleAssign(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    role: ClassRole | None


# ---------------------------------------------------------------- routes ----


def _account_exists(username: str) -> bool:
    from deeptutor.services.auth import AUTH_ENABLED, get_user_info

    if not AUTH_ENABLED:
        return True
    return get_user_info(username) is not None


@router.get("")
async def list_schools(_current=Depends(require_auth)) -> dict[str, Any]:
    user = _username()
    with _lock, closing(_connect()) as conn:
        rows = conn.execute(
            """SELECT s.id, s.name, s.created_at, m.role,
                      (SELECT COUNT(*) FROM members WHERE school_id=s.id) AS members,
                      (SELECT COUNT(*) FROM classes WHERE school_id=s.id) AS classes
               FROM schools s JOIN members m ON m.school_id=s.id AND m.username=?
               ORDER BY s.name""",
            (user,),
        ).fetchall()
    return {"user": user, "schools": [dict(r) for r in rows]}


@router.post("", status_code=201)
async def create_school(body: SchoolCreate, _current=Depends(require_auth)) -> dict[str, Any]:
    user = _username()
    school_id = uuid.uuid4().hex[:16]
    with _lock, closing(_connect()) as conn, conn:
        conn.execute(
            "INSERT INTO schools (id, name, created_by, created_at) VALUES (?,?,?,?)",
            (school_id, body.name.strip(), user, _now()),
        )
        conn.execute(
            "INSERT INTO members (school_id, username, role, added_by, added_at) VALUES (?,?,?,?,?)",
            (school_id, user, "admin", user, _now()),
        )
        _audit(conn, school_id, None, user, "create-school", body.name)
    return {"id": school_id, "name": body.name.strip(), "role": "admin"}


@router.get("/{school_id}")
async def get_school(school_id: str, _current=Depends(require_auth)) -> dict[str, Any]:
    user = _username()
    _check_id(school_id, "school")
    with _lock, closing(_connect()) as conn:
        my_role = _require_member(conn, school_id, user)
        school = conn.execute(
            "SELECT id, name, created_by, created_at FROM schools WHERE id=?", (school_id,)
        ).fetchone()
        members = [
            dict(r)
            for r in conn.execute(
                "SELECT username, role, added_at FROM members WHERE school_id=? ORDER BY role, username",
                (school_id,),
            )
        ]
        classes = []
        for row in conn.execute(
            "SELECT id, name, rev, updated_by, updated_at, created_by FROM classes WHERE school_id=? ORDER BY name",
            (school_id,),
        ):
            role = effective_class_role(conn, school_id, row["id"], user)
            if role is None:
                continue
            roles = [
                dict(r)
                for r in conn.execute(
                    "SELECT username, role FROM class_roles WHERE class_id=? ORDER BY username",
                    (row["id"],),
                )
            ]
            classes.append({**dict(row), "my_role": role, "roles": roles})
    return {"school": dict(school), "my_role": my_role, "members": members, "classes": classes}


@router.post("/{school_id}/members")
async def upsert_member(
    school_id: str, body: MemberUpsert, _current=Depends(require_auth)
) -> dict[str, Any]:
    user = _username()
    _check_id(school_id, "school")
    target = body.username.strip()
    if not _account_exists(target):
        raise HTTPException(
            status_code=404, detail=f"There is no DeepTutor account named '{target}'."
        )
    with _lock, closing(_connect()) as conn, conn:
        _require_admin(conn, school_id, user)
        current = _member_role(conn, school_id, target)
        if current == "admin" and body.role != "admin" and _admin_count(conn, school_id) <= 1:
            raise HTTPException(status_code=400, detail="A school needs at least one admin.")
        conn.execute(
            """INSERT INTO members (school_id, username, role, added_by, added_at) VALUES (?,?,?,?,?)
               ON CONFLICT(school_id, username) DO UPDATE SET role=excluded.role""",
            (school_id, target, body.role, user, _now()),
        )
        _audit(conn, school_id, None, user, "member", f"{target} -> {body.role}")
    return {"username": target, "role": body.role}


def _admin_count(conn: sqlite3.Connection, school_id: str) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM members WHERE school_id=? AND role='admin'", (school_id,)
    ).fetchone()[0]


@router.delete("/{school_id}/members/{username}")
async def remove_member(
    school_id: str, username: str, _current=Depends(require_auth)
) -> dict[str, Any]:
    user = _username()
    _check_id(school_id, "school")
    with _lock, closing(_connect()) as conn, conn:
        if username != user:
            _require_admin(conn, school_id, user)
        role = (
            _require_member(conn, school_id, username)
            if username == user
            else _member_role(conn, school_id, username)
        )
        if role is None:
            raise HTTPException(status_code=404, detail="Not a member.")
        if role == "admin" and _admin_count(conn, school_id) <= 1:
            raise HTTPException(status_code=400, detail="A school needs at least one admin.")
        conn.execute("DELETE FROM members WHERE school_id=? AND username=?", (school_id, username))
        conn.execute(
            "DELETE FROM class_roles WHERE username=? AND class_id IN (SELECT id FROM classes WHERE school_id=?)",
            (username, school_id),
        )
        _audit(conn, school_id, None, user, "remove-member", username)
    return {"removed": username}


@router.post("/{school_id}/classes", status_code=201)
async def create_class(
    school_id: str, body: ClassCreate, _current=Depends(require_auth)
) -> dict[str, Any]:
    user = _username()
    _check_id(school_id, "school")
    bundle = validate_bundle(body.bundle)
    class_id = _check_id(body.id, "class") if body.id else uuid.uuid4().hex[:20]
    with _lock, closing(_connect()) as conn, conn:
        _require_member(conn, school_id, user)
        if conn.execute("SELECT 1 FROM classes WHERE id=?", (class_id,)).fetchone():
            raise HTTPException(status_code=409, detail="This class is already shared.")
        now = _now()
        conn.execute(
            """INSERT INTO classes (id, school_id, name, bundle, rev, created_by, created_at, updated_by, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                class_id,
                school_id,
                bundle["class"]["name"],
                json.dumps(bundle),
                1,
                user,
                now,
                user,
                now,
            ),
        )
        conn.execute(
            "INSERT INTO class_roles (class_id, username, role) VALUES (?,?,?)",
            (class_id, user, "lead"),
        )
        _audit(conn, school_id, class_id, user, "publish-class", bundle["class"]["name"])
    return {"id": class_id, "rev": 1, "my_role": "lead"}


@router.get("/{school_id}/classes/{class_id}")
async def get_class(
    school_id: str, class_id: str, _current=Depends(require_auth)
) -> dict[str, Any]:
    user = _username()
    _check_id(school_id, "school")
    _check_id(class_id, "class")
    with _lock, closing(_connect()) as conn:
        role = _require_class_role(conn, school_id, class_id, user)
        row = _class_row(conn, school_id, class_id)
    return {
        "id": class_id,
        "rev": row["rev"],
        "my_role": role,
        "updated_by": row["updated_by"],
        "updated_at": row["updated_at"],
        "bundle": json.loads(row["bundle"]),
    }


@router.put("/{school_id}/classes/{class_id}")
async def update_class(
    school_id: str, class_id: str, body: ClassUpdate, _current=Depends(require_auth)
) -> dict[str, Any]:
    user = _username()
    _check_id(school_id, "school")
    _check_id(class_id, "class")
    bundle = validate_bundle(body.bundle)
    with _lock, closing(_connect()) as conn, conn:
        role = _require_class_role(conn, school_id, class_id, user)
        row = _class_row(conn, school_id, class_id)
        current = json.loads(row["bundle"])
        if body.base_rev != row["rev"]:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "Someone else changed this class since your last sync.",
                    "rev": row["rev"],
                    "bundle": current,
                    "updated_by": row["updated_by"],
                },
            )
        changed = changed_sections(current, bundle)
        denied = [s for s in changed if role not in SECTION_WRITERS[s]]
        if denied:
            raise HTTPException(
                status_code=403,
                detail=f"Your role in this class ({role}) cannot change: {', '.join(denied)}.",
            )
        if not changed:
            return {"id": class_id, "rev": row["rev"], "changed": []}
        new_rev = row["rev"] + 1
        conn.execute(
            "UPDATE classes SET bundle=?, name=?, rev=?, updated_by=?, updated_at=? WHERE id=?",
            (json.dumps(bundle), bundle["class"]["name"], new_rev, user, _now(), class_id),
        )
        _audit(conn, school_id, class_id, user, "update-class", ", ".join(changed))
    return {"id": class_id, "rev": new_rev, "changed": changed}


@router.delete("/{school_id}/classes/{class_id}")
async def delete_class(
    school_id: str, class_id: str, _current=Depends(require_auth)
) -> dict[str, Any]:
    user = _username()
    _check_id(school_id, "school")
    _check_id(class_id, "class")
    with _lock, closing(_connect()) as conn, conn:
        if _require_class_role(conn, school_id, class_id, user) != "lead":
            raise HTTPException(
                status_code=403,
                detail="Only the class lead or a school admin can remove a shared class.",
            )
        name = _class_row(conn, school_id, class_id)["name"]
        conn.execute("DELETE FROM class_roles WHERE class_id=?", (class_id,))
        conn.execute("DELETE FROM classes WHERE id=?", (class_id,))
        _audit(conn, school_id, class_id, user, "remove-class", name)
    return {"deleted": class_id}


@router.put("/{school_id}/classes/{class_id}/roles")
async def assign_role(
    school_id: str, class_id: str, body: RoleAssign, _current=Depends(require_auth)
) -> dict[str, Any]:
    user = _username()
    _check_id(school_id, "school")
    _check_id(class_id, "class")
    target = body.username.strip()
    with _lock, closing(_connect()) as conn, conn:
        if _require_class_role(conn, school_id, class_id, user) != "lead":
            raise HTTPException(
                status_code=403, detail="Only the class lead or a school admin can assign roles."
            )
        if _member_role(conn, school_id, target) is None:
            raise HTTPException(status_code=400, detail=f"{target} is not a member of this school.")
        if body.role is None:
            conn.execute(
                "DELETE FROM class_roles WHERE class_id=? AND username=?", (class_id, target)
            )
        else:
            conn.execute(
                """INSERT INTO class_roles (class_id, username, role) VALUES (?,?,?)
                   ON CONFLICT(class_id, username) DO UPDATE SET role=excluded.role""",
                (class_id, target, body.role),
            )
        leads = conn.execute(
            "SELECT COUNT(*) FROM class_roles WHERE class_id=? AND role='lead'", (class_id,)
        ).fetchone()[0]
        if leads == 0 and _admin_count(conn, school_id) == 0:
            raise HTTPException(status_code=400, detail="A class needs a lead.")
        _audit(
            conn, school_id, class_id, user, "class-role", f"{target} -> {body.role or 'removed'}"
        )
    return {"username": target, "role": body.role}


@router.get("/{school_id}/audit")
async def school_audit(school_id: str, _current=Depends(require_auth)) -> dict[str, Any]:
    user = _username()
    _check_id(school_id, "school")
    with _lock, closing(_connect()) as conn:
        _require_admin(conn, school_id, user)
        rows = conn.execute(
            "SELECT class_id, username, action, detail, at FROM audit WHERE school_id=? ORDER BY id DESC LIMIT 200",
            (school_id,),
        ).fetchall()
    return {"entries": [dict(r) for r in rows]}


@router.get("/{school_id}/report")
async def school_report(school_id: str, _current=Depends(require_auth)) -> dict[str, Any]:
    """Every class bundle in the school, for institutional reports (admins)."""
    user = _username()
    _check_id(school_id, "school")
    with _lock, closing(_connect()) as conn:
        _require_admin(conn, school_id, user)
        rows = conn.execute(
            "SELECT id, name, rev, updated_at, bundle FROM classes WHERE school_id=? ORDER BY name",
            (school_id,),
        ).fetchall()
    return {
        "classes": [
            {
                "id": r["id"],
                "name": r["name"],
                "rev": r["rev"],
                "updated_at": r["updated_at"],
                "bundle": json.loads(r["bundle"]),
            }
            for r in rows
        ]
    }
