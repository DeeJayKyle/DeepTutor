"""Deep Tutor Pro API: curriculum analysis, teaching content, Deep Solve and sync.

Deep Tutor Pro (github.com/DeeJayKyle/Deep-Tutor-Pro) is an offline-first
React app for Windows, Android and the web. It keeps the tutor's workspace on
the device and calls this router only for work that needs the server:

* ``/auth/login`` — exchanges a username and password for a bearer token, so
  the installed apps (whose pages are not served from this origin) can sign in.
* ``/curriculum/outline`` and ``/curriculum/unit`` — read a curriculum or
  teacher's guide and return its programme, classes, course units, topics,
  contact hours and learning objectives as structured data.
* ``/notes``, ``/slides`` — lecture notes for a topic, organised by contact
  hours and grounded in the tutor's uploaded references.
* ``/exam-format``, ``/assessment``, ``/questions`` — analyse a reference
  exam's format; write exams, coursework and assignments with marking
  schemes; fill question banks with worked solutions.
* ``/solve``, ``/transcribe``, ``/revise`` — Deep Solve chat over typed text,
  photographed questions, documents and voice notes; AI edits of any text.
* ``/sync`` — the tutor's private cloud copy of the workspace, versioned with
  a revision number so a stale device gets a conflict instead of overwriting.

The AI provider is chosen per request: ``openai`` or ``gemini`` when their
keys are configured on the server (``OPENAI_API_KEY`` / ``GEMINI_API_KEY``),
``auto`` prefers OpenAI and falls back to Gemini. Keys never leave the server.
"""

from __future__ import annotations

import asyncio
import base64
from datetime import datetime, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import time
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
import httpx
from pydantic import BaseModel, Field

from deeptutor.api.routers.auth import require_auth
from deeptutor.multi_user.paths import get_current_path_service

logger = logging.getLogger(__name__)

router = APIRouter()
public_router = APIRouter()

API_VERSION = "1.0"
MAX_DOCUMENT_CHARS = 300_000
MAX_SECTION_CHARS = 60_000
MAX_SOURCE_CHARS = 60_000
MAX_SYNC_BYTES = 80 * 1024 * 1024
MAX_SYNC_HISTORY = 10
MAX_IMAGES = 6
MAX_IMAGE_CHARS = 8_000_000  # base64 data URL length per image
MAX_AUDIO_CHARS = 20_000_000
LLM_TIMEOUT = 300.0

Provider = Literal["auto", "openai", "gemini"]

PROVIDERS: dict[str, dict[str, str]] = {
    "openai": {
        "label": "OpenAI",
        "base": "https://api.openai.com/v1",
        "key_env": "OPENAI_API_KEY",
        "model_env": "TUTORPRO_OPENAI_MODEL",
        "default_model": "gpt-5-mini",
    },
    "gemini": {
        "label": "Google Gemini",
        "base": "https://generativelanguage.googleapis.com/v1beta/openai",
        "key_env": "GEMINI_API_KEY",
        "model_env": "TUTORPRO_GEMINI_MODEL",
        "default_model": "gemini-flash-latest",
    },
}


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------


def available_providers() -> list[str]:
    return [name for name, p in PROVIDERS.items() if os.environ.get(p["key_env"], "").strip()]


def provider_model(name: str) -> str:
    p = PROVIDERS[name]
    return os.environ.get(p["model_env"], "").strip() or p["default_model"]


def resolve_provider(requested: str) -> str | None:
    """Pick the provider for a request; ``None`` means DeepTutor's own LLM."""
    available = available_providers()
    if requested in PROVIDERS and requested in available:
        return requested
    # ``auto`` (and an unavailable explicit choice) fall back in this order.
    for name in ("openai", "gemini"):
        if name in available:
            return name
    return None


async def _post_chat(provider: str, body: dict[str, Any]) -> dict[str, Any]:
    """POST an OpenAI-compatible chat completion (patched in tests)."""
    p = PROVIDERS[provider]
    headers = {"Authorization": f"Bearer {os.environ[p['key_env']].strip()}"}
    async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
        for attempt in range(3):
            response = await client.post(
                f"{p['base']}/chat/completions", json=body, headers=headers
            )
            if response.status_code in (429, 500, 502, 503, 504) and attempt < 2:
                await asyncio.sleep(4 * (attempt + 1))
                continue
            break
    if response.status_code >= 400:
        detail = ""
        try:
            detail = str(response.json().get("error", {}).get("message", ""))[:300]
        except Exception:  # noqa: BLE001 — body is not JSON
            detail = response.text[:300]
        logger.warning("Tutor Pro: %s returned %s: %s", provider, response.status_code, detail)
        if response.status_code == 429:
            raise HTTPException(
                429, f"{p['label']} is busy (rate limit). Wait a minute and try again."
            )
        if response.status_code in (401, 403):
            raise HTTPException(502, f"{p['label']} rejected the server's API key.")
        raise HTTPException(502, f"{p['label']} could not complete the request. {detail}".strip())
    return response.json()


async def _fallback_complete(messages: list[dict[str, Any]]) -> str:
    """Use DeepTutor's configured LLM when no provider key is in the environment."""
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
    parts: list[str] = []
    for m in messages:
        if m["role"] == "system":
            continue
        content = m["content"]
        if isinstance(content, list):
            if any(part.get("type") != "text" for part in content):
                raise HTTPException(
                    400,
                    "Reading images and voice needs GEMINI_API_KEY or OPENAI_API_KEY on the server.",
                )
            content = "\n".join(part.get("text", "") for part in content)
        parts.append(f"{m['role'].upper()}: {content}" if len(messages) > 2 else str(content))
    try:
        from deeptutor.services.llm import complete
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, "No AI model is configured on the server.") from exc
    try:
        return await complete("\n\n".join(parts), system_prompt=system or None)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — surface a readable message
        logger.exception("Tutor Pro fallback LLM failed")
        raise HTTPException(502, f"The AI model could not complete the request: {exc}") from exc


async def run_llm(
    messages: list[dict[str, Any]], provider: str = "auto", *, json_mode: bool = False
) -> tuple[str, str]:
    """Run a chat completion. Returns (text, model label)."""
    name = resolve_provider(provider)
    if name is None:
        return await _fallback_complete(messages), "server default"
    body: dict[str, Any] = {"model": provider_model(name), "messages": messages}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    data = await _post_chat(name, body)
    try:
        text = data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as exc:
        raise HTTPException(502, "The AI provider returned an empty answer.") from exc
    if not text.strip():
        raise HTTPException(502, "The AI provider returned an empty answer. Try again.")
    return text, f"{PROVIDERS[name]['label']} · {provider_model(name)}"


def parse_json_reply(text: str) -> dict[str, Any]:
    """Parse a JSON object from a model reply, tolerating code fences and prose."""
    cleaned = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", text.strip())
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start < 0 or end <= start:
            raise HTTPException(502, "The AI reply was not valid structured data. Try again.")
        try:
            value = json.loads(cleaned[start : end + 1])
        except json.JSONDecodeError as exc:
            raise HTTPException(
                502, "The AI reply was cut off or malformed. Try again or use a shorter document."
            ) from exc
    if not isinstance(value, dict):
        raise HTTPException(502, "The AI reply was not a JSON object.")
    return value


async def run_json(system: str, prompt: str, provider: str) -> tuple[dict[str, Any], str]:
    messages = [{"role": "system", "content": system}, {"role": "user", "content": prompt}]
    text, model = await run_llm(messages, provider, json_mode=True)
    return parse_json_reply(text), model


# ---------------------------------------------------------------------------
# Normalisers (pure; unit-tested)
# ---------------------------------------------------------------------------


def _s(value: Any, limit: int = 2000) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        value = "; ".join(_s(v, limit) for v in value if v)
    return re.sub(r"[ \t]+", " ", str(value)).strip()[:limit]


def _num(value: Any, default: float = 0.0, lo: float = 0.0, hi: float = 100_000.0) -> float:
    if isinstance(value, str):
        match = re.search(r"-?\d+(?:\.\d+)?", value)
        value = match.group(0) if match else None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number:  # NaN
        return default
    return max(lo, min(hi, number))


def _int(value: Any, default: int = 0, lo: int = 0, hi: int = 100_000) -> int:
    return int(round(_num(value, default, lo, hi)))


def _list(value: Any, limit: int = 60, item_limit: int = 600) -> list[str]:
    if isinstance(value, str):
        value = [v for v in re.split(r"\n+|;\s*", value) if v.strip()]
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        if isinstance(item, dict):
            item = item.get("text") or item.get("title") or item.get("name") or ""
        text = re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "", _s(item, item_limit))
        if text:
            out.append(text)
    return out[:limit]


def normalize_outline(data: dict[str, Any]) -> dict[str, Any]:
    programme = data.get("programme") if isinstance(data.get("programme"), dict) else {}
    units = []
    seen: set[str] = set()
    for raw in data.get("units") or []:
        if not isinstance(raw, dict):
            continue
        title = _s(raw.get("title"), 300)
        if not title:
            continue
        code = _s(raw.get("code"), 40)
        key = (code or title).lower()
        if key in seen:
            continue
        seen.add(key)
        hours = {
            k: _num(raw.get(f"{k}_hours"), 0, 0, 5000)
            for k in ("lecture", "tutorial", "practical", "clinical")
        }
        total = _num(raw.get("total_hours"), 0, 0, 10_000) or sum(hours.values())
        units.append(
            {
                "code": code,
                "title": title,
                "year": _int(raw.get("year"), 1, 1, 10) or 1,
                "semester": _int(raw.get("semester"), 1, 0, 4),
                "credit_units": _num(raw.get("credit_units"), 0, 0, 100),
                **{f"{k}_hours": v for k, v in hours.items()},
                "total_hours": total,
                "start_marker": _s(raw.get("start_marker"), 200),
            }
        )
    years = sorted({u["year"] for u in units}) or [1]
    duration = _int(programme.get("duration_years"), 0, 0, 10) or max(years)
    classes = []
    for raw in data.get("classes") or []:
        if isinstance(raw, dict) and _s(raw.get("name")):
            classes.append(
                {"name": _s(raw.get("name"), 120), "year": _int(raw.get("year"), 1, 1, 10) or 1}
            )
    if not classes:
        short = _s(programme.get("title"), 120) or "Programme"
        classes = [{"name": f"{short} — Year {y}", "year": y} for y in range(1, duration + 1)]
    return {
        "programme": {
            "title": _s(programme.get("title"), 200) or "Imported curriculum",
            "institution": _s(programme.get("institution"), 200),
            "award_level": _s(programme.get("award_level"), 80),
            "duration_years": duration,
            "total_hours": _num(programme.get("total_hours"), 0, 0, 100_000)
            or sum(u["total_hours"] for u in units),
            "overview": _s(programme.get("overview"), 4000),
            "entry_requirements": _s(programme.get("entry_requirements"), 2000),
            "assessment_policy": _s(programme.get("assessment_policy"), 3000),
        },
        "classes": classes,
        "units": units,
    }


def normalize_unit_detail(data: dict[str, Any], unit_total_hours: float = 0) -> dict[str, Any]:
    topics = []
    for raw in data.get("topics") or []:
        if isinstance(raw, str):
            raw = {"title": raw}
        if not isinstance(raw, dict) or not _s(raw.get("title")):
            continue
        topics.append(
            {
                "title": _s(raw.get("title"), 300),
                "hours": _num(raw.get("hours"), 0, 0, 1000),
                "objectives": _list(raw.get("objectives")),
                "subtopics": _list(raw.get("subtopics"), 80),
                "practicals": _s(raw.get("practicals"), 1500),
            }
        )
    estimated = bool(data.get("hours_estimated"))
    missing = [t for t in topics if not t["hours"]]
    if topics and missing:
        known = sum(t["hours"] for t in topics)
        remaining = max(0.0, unit_total_hours - known)
        share = remaining / len(missing) if remaining else 2.0
        for t in missing:
            t["hours"] = round(share * 2) / 2 or 1.0
        estimated = True
    return {
        "overview": _s(data.get("overview"), 4000),
        "aims": _list(data.get("aims")),
        "learning_outcomes": _list(data.get("learning_outcomes")),
        "topics": topics,
        "teaching_methods": _list(data.get("teaching_methods"), 20),
        "assessment": _s(data.get("assessment"), 2000),
        "references": _list(data.get("references"), 40),
        "hours_estimated": estimated,
    }


QUESTION_TYPES = (
    "mcq",
    "true_false",
    "short",
    "structured",
    "essay",
    "case",
    "fill",
    "matching",
    "calculation",
    "practical",
)


def _qtype(value: Any) -> str:
    text = _s(value, 40).lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "multiple_choice": "mcq",
        "objective": "mcq",
        "short_answer": "short",
        "saq": "short",
        "long_essay": "essay",
        "long_answer": "essay",
        "leq": "essay",
        "case_study": "case",
        "fill_in": "fill",
        "fill_in_the_blank": "fill",
        "true/false": "true_false",
        "truefalse": "true_false",
    }
    text = aliases.get(text, text)
    return text if text in QUESTION_TYPES else "short"


def normalize_question(raw: Any, default_type: str = "short") -> dict[str, Any] | None:
    if not isinstance(raw, dict) or not _s(raw.get("prompt")):
        return None
    qtype = _qtype(raw.get("type") or default_type)
    options = _list(raw.get("options"), 8, 600) if qtype in ("mcq", "true_false") else []
    if qtype == "true_false" and not options:
        options = ["True", "False"]
    answer_index = raw.get("answer_index")
    if options:
        idx = _int(answer_index, -1, -1, len(options) - 1) if answer_index is not None else -1
        if idx < 0:
            letter = _s(raw.get("answer"), 10).strip().upper()[:1]
            idx = ord(letter) - 65 if letter and "A" <= letter <= "H" else -1
        answer_index = idx if 0 <= idx < len(options) else None
    else:
        answer_index = None
    points = []
    for point in raw.get("marking_points") or []:
        if isinstance(point, dict) and _s(point.get("point")):
            points.append(
                {"point": _s(point.get("point"), 600), "marks": _num(point.get("marks"), 1, 0, 100)}
            )
        elif isinstance(point, str) and point.strip():
            points.append({"point": _s(point, 600), "marks": 1.0})
    marks = _num(raw.get("marks"), 0, 0, 200) or (sum(p["marks"] for p in points) or 1.0)
    answer = _s(raw.get("answer"), 6000)
    if options and answer_index is not None:
        answer = f"{chr(65 + answer_index)}. {options[answer_index]}"
    return {
        "type": qtype,
        "prompt": _s(raw.get("prompt"), 6000),
        "options": options,
        "answer_index": answer_index,
        "answer": answer,
        "solution": _s(raw.get("solution") or raw.get("explanation"), 12_000),
        "marking_points": points[:30],
        "marks": marks,
        "topic": _s(raw.get("topic"), 300),
        "difficulty": _s(raw.get("difficulty"), 30).lower() or "moderate",
        "outcome": _s(raw.get("outcome"), 400),
    }


def normalize_paper(data: dict[str, Any]) -> dict[str, Any]:
    sections = []
    for raw in data.get("sections") or []:
        if not isinstance(raw, dict):
            continue
        qtype = _qtype(raw.get("type"))
        questions = [
            q for q in (normalize_question(x, qtype) for x in raw.get("questions") or []) if q
        ]
        if not questions:
            continue
        sections.append(
            {
                "title": _s(raw.get("title"), 200) or f"Section {chr(65 + len(sections))}",
                "type": qtype,
                "instructions": _s(raw.get("instructions"), 1500),
                "choose": _int(raw.get("choose"), 0, 0, 100),
                "questions": questions,
            }
        )
    total = 0.0
    for section in sections:
        marks = sorted((q["marks"] for q in section["questions"]), reverse=True)
        total += sum(marks[: section["choose"]] if section["choose"] else marks)
    return {
        "title": _s(data.get("title"), 300),
        "instructions": _s(data.get("instructions"), 4000),
        "duration": _s(data.get("duration"), 60),
        "total_marks": round(total, 2),
        "sections": sections,
    }


def normalize_format(data: dict[str, Any]) -> dict[str, Any]:
    sections = []
    for raw in data.get("sections") or []:
        if not isinstance(raw, dict):
            continue
        count = _int(raw.get("count"), 0, 0, 200)
        if not count:
            continue
        sections.append(
            {
                "title": _s(raw.get("title"), 200) or f"Section {chr(65 + len(sections))}",
                "type": _qtype(raw.get("type")),
                "count": count,
                "marks_each": _num(raw.get("marks_each"), 1, 0, 200) or 1,
                "choose": _int(raw.get("choose"), 0, 0, count),
                "instructions": _s(raw.get("instructions"), 1500),
            }
        )
    return {
        "name": _s(data.get("name"), 200) or "Reference exam format",
        "duration": _s(data.get("duration"), 60),
        "instructions": _s(data.get("instructions"), 3000),
        "style_notes": _s(data.get("style_notes"), 3000),
        "sections": sections,
    }


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class SourceText(BaseModel):
    id: str = Field(default="", max_length=40)
    title: str = Field(default="", max_length=300)
    text: str = Field(default="", max_length=MAX_SOURCE_CHARS)


class UnitContext(BaseModel):
    code: str = Field(default="", max_length=60)
    title: str = Field(min_length=1, max_length=300)
    year: int = Field(default=1, ge=0, le=10)
    overview: str = Field(default="", max_length=4000)
    total_hours: float = Field(default=0, ge=0, le=10_000)


class TopicContext(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    hours: float = Field(default=0, ge=0, le=1000)
    objectives: list[str] = Field(default_factory=list, max_length=60)
    subtopics: list[str] = Field(default_factory=list, max_length=100)
    practicals: str = Field(default="", max_length=1500)


class OutlineRequest(BaseModel):
    text: str = Field(min_length=20, max_length=MAX_DOCUMENT_CHARS * 2)
    title_hint: str = Field(default="", max_length=200)
    provider: Provider = "auto"


class UnitDetailRequest(BaseModel):
    programme: str = Field(default="", max_length=300)
    unit: UnitContext
    text: str = Field(min_length=1, max_length=MAX_DOCUMENT_CHARS * 2)
    provider: Provider = "auto"


class NotesRequest(BaseModel):
    programme: str = Field(default="", max_length=300)
    unit: UnitContext
    topic: TopicContext
    hour_start: float = Field(default=1, ge=0, le=10_000)
    sources: list[SourceText] = Field(default_factory=list, max_length=12)
    detail: Literal["brief", "standard", "comprehensive"] = "standard"
    audience: str = Field(default="", max_length=200)
    instructions: str = Field(default="", max_length=3000)
    provider: Provider = "auto"


class SlidesRequest(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    markdown: str = Field(min_length=1, max_length=200_000)
    max_slides: int = Field(default=16, ge=3, le=60)
    provider: Provider = "auto"


class ExamFormatRequest(BaseModel):
    text: str = Field(min_length=20, max_length=MAX_DOCUMENT_CHARS)
    provider: Provider = "auto"


class FormatSection(BaseModel):
    title: str = Field(default="", max_length=200)
    type: str = Field(default="short", max_length=40)
    count: int = Field(ge=1, le=200)
    marks_each: float = Field(default=1, ge=0, le=200)
    choose: int = Field(default=0, ge=0, le=200)
    instructions: str = Field(default="", max_length=1500)


class AssessmentRequest(BaseModel):
    kind: Literal["exam", "coursework", "assignment", "test", "quiz", "practical"] = "exam"
    programme: str = Field(default="", max_length=300)
    unit: UnitContext
    topics: list[TopicContext] = Field(min_length=1, max_length=80)
    sections: list[FormatSection] = Field(min_length=1, max_length=12)
    duration: str = Field(default="", max_length=60)
    difficulty: Literal["easy", "moderate", "hard", "mixed"] = "mixed"
    style_notes: str = Field(default="", max_length=3000)
    instructions: str = Field(default="", max_length=3000)
    sources: list[SourceText] = Field(default_factory=list, max_length=12)
    provider: Provider = "auto"


class QuestionsRequest(BaseModel):
    unit: UnitContext
    topic: TopicContext
    count: int = Field(default=10, ge=1, le=60)
    types: list[str] = Field(default_factory=lambda: ["mcq", "short", "essay"], max_length=10)
    difficulty: Literal["easy", "moderate", "hard", "mixed"] = "mixed"
    sources: list[SourceText] = Field(default_factory=list, max_length=8)
    provider: Provider = "auto"


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=60_000)


class SolveRequest(BaseModel):
    mode: Literal["solve", "tutor", "mark"] = "solve"
    text: str = Field(default="", max_length=60_000)
    history: list[ChatTurn] = Field(default_factory=list, max_length=40)
    images: list[str] = Field(default_factory=list, max_length=MAX_IMAGES)
    documents: list[SourceText] = Field(default_factory=list, max_length=8)
    context: str = Field(default="", max_length=4000)
    provider: Provider = "auto"


class TranscribeRequest(BaseModel):
    audio: str = Field(min_length=10, max_length=MAX_AUDIO_CHARS)  # base64 WAV
    language: str = Field(default="", max_length=20)
    provider: Provider = "auto"


class ReviseRequest(BaseModel):
    instruction: str = Field(min_length=1, max_length=3000)
    content: str = Field(min_length=1, max_length=200_000)
    context: str = Field(default="", max_length=4000)
    provider: Provider = "auto"


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=500)


class RegisterBody(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=8, max_length=500)


class SyncPut(BaseModel):
    base_rev: int = Field(ge=0)
    device: str = Field(default="", max_length=120)
    sha256: str = Field(min_length=64, max_length=64)
    data: str
    force: bool = False


# ---------------------------------------------------------------------------
# Prompts (pure; unit-tested)
# ---------------------------------------------------------------------------

ANALYST_SYSTEM = (
    "You are an expert curriculum analyst for medical, health-science and technical "
    "colleges. You read curricula, syllabi and teacher's guides and return their "
    "structure as JSON. Use only what the document says: copy codes, titles and hours "
    "exactly; never invent hours, codes or units. Leave a field empty or 0 when the "
    "document does not give it. Reply with one JSON object and nothing else."
)

AUTHOR_SYSTEM = (
    "You are an experienced lecturer and curriculum-aligned content author for tertiary "
    "health-science and technical programmes. Write accurate, well-structured, exam-ready "
    "teaching material in Markdown. When reference excerpts are provided, ground the "
    "content in them and tag statements drawn from a reference with [Source: S#] using the "
    "excerpt id. Never invent citations, statistics, drug doses or guideline numbers; where "
    "the references are silent, use standard textbook knowledge and do not tag it. Flag "
    "anything a tutor must verify with '(verify)'."
)

EXAMINER_SYSTEM = (
    "You are a senior examiner who sets and moderates examinations for tertiary "
    "health-science and technical programmes. Write clear, unambiguous, syllabus-aligned "
    "questions at the requested level, with complete marking schemes and worked model "
    "answers. MCQs have exactly one correct option and plausible distractors. Marks in each "
    "marking scheme add up to the question's marks. Reply with one JSON object only."
)

SOLVER_SYSTEMS = {
    "solve": (
        "You are Deep Solve, a meticulous tutor that solves academic problems, exam "
        "questions and assignments. Read every attached image and document carefully. "
        "Restate what is asked, plan, then solve step by step with clear reasoning, "
        "formulas and units. Check the result, then give a clearly labelled **Final answer**. "
        "For MCQs, explain why each other option is wrong. For essays and assignments, give "
        "a structured model answer with headings. Use Markdown and LaTeX-free plain maths."
    ),
    "tutor": (
        "You are a friendly, expert tutor for health-science and technical students and "
        "their lecturers. Explain clearly with examples, check understanding, and keep "
        "answers well organised in Markdown."
    ),
    "mark": (
        "You are an examiner marking a student's answer. Compare it with the question and "
        "any marking scheme provided, award marks point by point, give the total, and give "
        "short, specific feedback on how to improve. Use a Markdown table for the breakdown."
    ),
}


def _sources_block(sources: list[SourceText], budget: int = MAX_SOURCE_CHARS) -> str:
    if not sources:
        return ""
    per = max(2000, budget // len(sources))
    parts = ["REFERENCE EXCERPTS (cite as [Source: S#]):"]
    for i, src in enumerate(sources, start=1):
        sid = src.id or f"S{i}"
        parts.append(f"--- {sid}: {src.title or 'Untitled'} ---\n{src.text[:per].strip()}")
    return "\n\n".join(parts)


def _unit_line(unit: UnitContext, programme: str = "") -> str:
    head = f"{unit.code} {unit.title}".strip()
    bits = [f"Course unit: {head}"]
    if programme:
        bits.append(f"Programme: {programme}")
    if unit.year:
        bits.append(f"Year of study: {unit.year}")
    return "\n".join(bits)


def _hours_label(start: float, hours: float) -> str:
    def fmt(x: float) -> str:
        return str(int(x)) if float(x).is_integer() else f"{x:g}"

    if hours <= 0:
        return ""
    end = start + hours - 1 if float(hours).is_integer() else start + hours
    return f"{fmt(start)}–{fmt(end)}" if end > start else fmt(start)


def build_outline_prompt(req: OutlineRequest) -> str:
    text = req.text[:MAX_DOCUMENT_CHARS]
    return "\n".join(
        [
            "Analyse this curriculum / teacher's guide and return JSON with this shape:",
            '{"programme": {"title": "", "institution": "", "award_level": "Certificate|Diploma|Degree|...", '
            '"duration_years": 0, "total_hours": 0, "overview": "", "entry_requirements": "", '
            '"assessment_policy": "grading, weights of coursework vs exam, pass mark"},',
            ' "classes": [{"name": "e.g. Diploma in Pharmacy Year 1", "year": 1}],',
            ' "units": [{"code": "", "title": "", "year": 1, "semester": 1, "credit_units": 0, '
            '"lecture_hours": 0, "tutorial_hours": 0, "practical_hours": 0, "clinical_hours": 0, '
            '"total_hours": 0, "start_marker": "the exact heading line where this unit\'s detailed '
            'content begins in the document"}]}',
            "List every course unit / module / subject in the order they appear, with the year and "
            "semester in which it is taught. One class per year of study.",
            f"Title hint from the tutor: {req.title_hint}" if req.title_hint else "",
            "",
            "DOCUMENT:",
            text,
        ]
    )


def build_unit_prompt(req: UnitDetailRequest) -> str:
    section = req.text[:MAX_SECTION_CHARS]
    return "\n".join(
        [
            _unit_line(req.unit, req.programme),
            f"Total contact hours for this unit: {req.unit.total_hours:g}"
            if req.unit.total_hours
            else "",
            "From the document section below, extract this unit's full outline as JSON:",
            '{"overview": "", "aims": [], "learning_outcomes": [], "topics": [{"title": "", '
            '"hours": 0, "objectives": [], "subtopics": [], "practicals": ""}], '
            '"teaching_methods": [], "assessment": "", "references": [], "hours_estimated": false}',
            "Keep topics in teaching order. Copy each topic's contact hours from the document. If "
            "the document gives no hours per topic, share the unit's total hours across topics in "
            "proportion to their content and set hours_estimated to true. Objectives are the "
            'specific learning objectives listed for the topic ("By the end of this topic the '
            'learner should be able to...").',
            "",
            "DOCUMENT SECTION:",
            section,
        ]
    )


DETAIL_BRIEF = {
    "brief": "concise notes (about 900–1400 words)",
    "standard": "full lecture notes (about 1800–2800 words)",
    "comprehensive": "comprehensive, detailed lecture notes (about 3500–5000 words)",
}


def build_notes_prompt(req: NotesRequest) -> str:
    topic = req.topic
    hours = _hours_label(req.hour_start, topic.hours)
    lines = [
        _unit_line(req.unit, req.programme),
        f"Topic: {topic.title}",
        f"Contact hours for this topic: {topic.hours:g} (unit hours {hours})" if hours else "",
        "Learning objectives:\n" + "\n".join(f"- {o}" for o in topic.objectives)
        if topic.objectives
        else "",
        "Subtopics to cover:\n" + "\n".join(f"- {s}" for s in topic.subtopics)
        if topic.subtopics
        else "",
        f"Practicals: {topic.practicals}" if topic.practicals else "",
        f"Audience: {req.audience}" if req.audience else "",
        "",
        f"Write {DETAIL_BRIEF[req.detail]} in Markdown for this topic, organised by contact hours:",
        f"# {topic.title}",
        "## Learning objectives",
        "## Introduction",
        "Then one '## Contact hour N: <focus>' section per contact hour (or '## Contact hours N–M: <focus>' "
        "for a 2-hour session), numbered with the unit hour numbers above, each with explanations, "
        "definitions, examples, a table where it helps, and clinical / practical application.",
        "## Practical / class activity",
        "## Summary of key points",
        "## Revision questions (with brief answers)",
        "## References",
    ]
    if req.instructions:
        lines += ["", f"Tutor's instructions: {req.instructions}"]
    block = _sources_block(req.sources)
    if block:
        lines += ["", block]
    return "\n".join(line for line in lines if line is not None)


def build_slides_prompt(req: SlidesRequest) -> str:
    return "\n".join(
        [
            f"Turn these lecture notes into a presentation of at most {req.max_slides} slides.",
            "Format: '# <deck title>' once, then for each slide '## <slide title>', 3–6 short bullet "
            "points ('- '), and a line 'Notes: <speaker notes>'. Keep [Source: S#] tags on the bullets "
            "they belong to. Start with a title/objectives slide and end with a summary slide.",
            f"Deck title: {req.title}",
            "",
            "NOTES:",
            req.markdown[:120_000],
        ]
    )


def build_exam_format_prompt(req: ExamFormatRequest) -> str:
    return "\n".join(
        [
            "This is a reference examination paper. Describe its format so new papers can follow "
            "it, as JSON:",
            '{"name": "", "duration": "", "instructions": "the rubric / instructions to candidates", '
            '"style_notes": "how questions are worded, verbs used, level, how marks are shown", '
            '"sections": [{"title": "Section A", "type": "mcq|true_false|short|structured|essay|case|'
            'fill|matching|calculation|practical", "count": 0, "marks_each": 0, "choose": 0, '
            '"instructions": ""}]}',
            "choose = how many questions candidates must answer when they choose (0 = all).",
            "",
            "PAPER:",
            req.text[:MAX_DOCUMENT_CHARS],
        ]
    )


KIND_LABEL = {
    "exam": "an end-of-semester examination paper",
    "coursework": "a continuous assessment (coursework) test",
    "assignment": "a take-home assignment",
    "test": "a class test",
    "quiz": "a short quiz",
    "practical": "a practical / OSPE assessment",
}

QUESTION_SHAPE = (
    '{"type": "mcq|true_false|short|structured|essay|case|fill|matching|calculation|practical", '
    '"prompt": "", "options": ["for mcq only"], "answer_index": 0, "answer": "short correct answer", '
    '"marks": 0, "topic": "", "difficulty": "easy|moderate|hard", "outcome": "objective assessed", '
    '"marking_points": [{"point": "", "marks": 0}], "solution": "worked model answer"}'
)


def build_assessment_prompt(req: AssessmentRequest) -> str:
    total = sum(s.marks_each * (s.choose or s.count) for s in req.sections)
    lines = [
        _unit_line(req.unit, req.programme),
        f"Write {KIND_LABEL[req.kind]}. Difficulty: {req.difficulty}.",
        f"Duration: {req.duration}" if req.duration else "",
        f"Total marks: {total:g}",
        "Topics to test (spread questions across them in proportion to their contact hours):",
        *[
            f"- {t.title}"
            + (f" ({t.hours:g} h)" if t.hours else "")
            + (f" — objectives: {'; '.join(t.objectives[:8])}" if t.objectives else "")
            for t in req.topics
        ],
        "Required sections:",
        *[
            f"- {s.title or f'Section {chr(65 + i)}'}: {s.count} {s.type} question(s), "
            f"{s.marks_each:g} mark(s) each"
            + (f", candidates answer any {s.choose}" if s.choose else "")
            + (f". {s.instructions}" if s.instructions else "")
            for i, s in enumerate(req.sections)
        ],
        f"Follow this reference style: {req.style_notes}" if req.style_notes else "",
        f"Tutor's instructions: {req.instructions}" if req.instructions else "",
        "",
        'Return JSON: {"title": "", "instructions": "rubric for candidates", "duration": "", '
        '"sections": [{"title": "", "type": "", "instructions": "", "choose": 0, '
        f'"questions": [{QUESTION_SHAPE}]}}]}}',
        "Every question needs its marking scheme (marking_points summing to its marks) and a "
        "model answer in solution. Write exactly the number of questions requested per section.",
    ]
    block = _sources_block(req.sources, 40_000)
    if block:
        lines += ["", block]
    return "\n".join(line for line in lines if line)


def build_questions_prompt(req: QuestionsRequest) -> str:
    lines = [
        _unit_line(req.unit),
        f"Topic: {req.topic.title}",
        "Objectives: " + "; ".join(req.topic.objectives[:12]) if req.topic.objectives else "",
        "Subtopics: " + "; ".join(req.topic.subtopics[:20]) if req.topic.subtopics else "",
        f"Write {req.count} question-bank questions of these types: {', '.join(req.types)}. "
        f"Difficulty: {req.difficulty}. Cover different objectives and subtopics.",
        f'Return JSON: {{"questions": [{QUESTION_SHAPE}]}}',
        "Each question needs a full worked solution and a marking scheme.",
    ]
    block = _sources_block(req.sources, 30_000)
    if block:
        lines += ["", block]
    return "\n".join(line for line in lines if line)


def build_solve_messages(req: SolveRequest) -> list[dict[str, Any]]:
    system = SOLVER_SYSTEMS[req.mode]
    if req.context:
        system += f"\n\nContext from the tutor's workspace: {req.context}"
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    for turn in req.history[-20:]:
        messages.append({"role": turn.role, "content": turn.content})
    text = req.text.strip()
    if req.documents:
        docs = "\n\n".join(
            f"--- Attached document: {d.title or 'document'} ---\n{d.text[:30_000]}"
            for d in req.documents
        )
        text = f"{text}\n\n{docs}".strip()
    if not text and req.images:
        text = "Solve the question(s) in the attached image(s)."
    if not text:
        raise HTTPException(400, "Type a question or attach a photo, document or voice note.")
    if req.images:
        parts: list[dict[str, Any]] = [{"type": "text", "text": text}]
        for image in req.images:
            if not re.match(r"^data:image/(png|jpe?g|webp|gif);base64,", image):
                raise HTTPException(400, "Images must be PNG, JPEG, WebP or GIF.")
            if len(image) > MAX_IMAGE_CHARS:
                raise HTTPException(413, "An image is too large; use a smaller photo.")
            parts.append({"type": "image_url", "image_url": {"url": image}})
        messages.append({"role": "user", "content": parts})
    else:
        messages.append({"role": "user", "content": text})
    return messages


# ---------------------------------------------------------------------------
# Public: sign-in for the installed apps
# ---------------------------------------------------------------------------


@public_router.get("/ping")
async def ping() -> dict[str, Any]:
    from deeptutor.services.auth import AUTH_ENABLED

    return {
        "ok": True,
        "app": "deep-tutor-pro",
        "api": API_VERSION,
        "auth_required": bool(AUTH_ENABLED),
        "signup": bool(AUTH_ENABLED) and signup_open(),
    }


@public_router.post("/auth/login")
async def login(body: LoginBody, request: Request) -> dict[str, Any]:
    """Return a bearer token for the Deep Tutor Pro apps."""
    from deeptutor.api.routers.auth import _require_private_frontend
    from deeptutor.services.auth import (
        AUTH_ENABLED,
        POCKETBASE_ENABLED,
        TOKEN_EXPIRE_HOURS,
        authenticate,
        authenticate_pb,
        create_token,
    )

    if not AUTH_ENABLED:
        return {"ok": True, "token": "", "username": "local", "role": "admin", "auth": False}
    _require_private_frontend(request)
    if POCKETBASE_ENABLED:
        result = authenticate_pb(body.username, body.password)
        if not result:
            raise HTTPException(401, "Incorrect username or password")
        payload, token = result
        username, role = payload.username, payload.role
    else:
        user = authenticate(body.username, body.password)
        if not user:
            raise HTTPException(401, "Incorrect username or password")
        token = create_token(user.username, user.role, user.user_id)
        username, role = user.username, user.role
    logger.info("Deep Tutor Pro sign-in for '%s'", username)
    return {
        "ok": True,
        "token": token,
        "username": username,
        "role": role,
        "auth": True,
        "expires_hours": TOKEN_EXPIRE_HOURS,
    }


# Self sign-up for tutors. Accounts made here are always ordinary users with
# their own private workspace and cloud copy; the server owner stays the only
# administrator. Set TUTORPRO_SELF_SIGNUP=0 to close it.
_USERNAME_RE = re.compile(r"^(?:[A-Za-z0-9_.-]{3,64}|[^@\s]{1,64}@[^@\s]+\.[^@\s]+)$")
SIGNUP_PER_CLIENT_PER_HOUR = 5
SIGNUP_PER_HOUR = 60
_signups: list[tuple[float, str]] = []


def signup_open() -> bool:
    flag = os.environ.get("TUTORPRO_SELF_SIGNUP", "1").strip().lower()
    return flag not in {"0", "false", "no", "off"}


def _client_key(request: Request) -> str:
    # Behind the Cloudflare Worker the visitor's address is in CF-Connecting-IP.
    forwarded = request.headers.get("cf-connecting-ip", "").strip()
    return forwarded or (request.client.host if request.client else "unknown")


def _allow_signup(client: str) -> bool:
    now = time.monotonic()
    _signups[:] = [(t, c) for t, c in _signups if now - t < 3600]
    if len(_signups) >= SIGNUP_PER_HOUR:
        return False
    return sum(1 for _, c in _signups if c == client) < SIGNUP_PER_CLIENT_PER_HOUR


@public_router.post("/auth/register", status_code=201)
async def register(body: RegisterBody, request: Request) -> dict[str, Any]:
    """Create a tutor account and return a bearer token for it."""
    from deeptutor.api.routers.auth import _require_private_frontend
    from deeptutor.services.auth import (
        AUTH_ENABLED,
        POCKETBASE_ENABLED,
        TOKEN_EXPIRE_HOURS,
        add_user,
        authenticate,
        create_token,
        delete_user,
        is_first_user,
        list_users,
    )

    if not AUTH_ENABLED:
        raise HTTPException(400, "This server does not use accounts; sign in with any name.")
    if not signup_open() or POCKETBASE_ENABLED:
        raise HTTPException(403, "Sign-up is closed on this server. Ask its owner for an account.")
    _require_private_frontend(request)
    username = body.username.strip()
    if not _USERNAME_RE.match(username):
        raise HTTPException(
            422,
            "Use 3–64 letters, numbers, dots, dashes or underscores, or an email address.",
        )
    if is_first_user():
        # Never let a visitor become the first (administrator) account.
        raise HTTPException(
            403, "This server has no administrator yet; its owner must set it up first."
        )
    if any(str(u.get("username", "")).lower() == username.lower() for u in list_users()):
        raise HTTPException(409, "That username is taken. Choose another, or sign in.")
    client = _client_key(request)
    if not _allow_signup(client):
        raise HTTPException(429, "Too many new accounts from here. Try again in an hour.")
    _signups.append((time.monotonic(), client))

    add_user(username, body.password, role="user")
    user = authenticate(username, body.password)
    if user is None or user.role != "user":
        delete_user(username)
        logger.error("Deep Tutor Pro sign-up for '%s' did not produce a user account", username)
        raise HTTPException(500, "The account could not be created. Please try again.")
    logger.info("Deep Tutor Pro account created for '%s'", username)
    return {
        "ok": True,
        "token": create_token(user.username, user.role, user.user_id),
        "username": user.username,
        "role": user.role,
        "auth": True,
        "expires_hours": TOKEN_EXPIRE_HOURS,
    }


# ---------------------------------------------------------------------------
# Authenticated endpoints
# ---------------------------------------------------------------------------


@router.get("/status")
async def status(current=Depends(require_auth)) -> dict[str, Any]:
    available = available_providers()
    default = resolve_provider("auto")
    return {
        "api": API_VERSION,
        "user": getattr(current, "username", "") or "local",
        "role": getattr(current, "role", "") or "admin",
        "providers": [
            {"id": name, "label": PROVIDERS[name]["label"], "model": provider_model(name)}
            for name in available
        ],
        "default_provider": default or "server",
        "ai_available": bool(available) or _server_llm_configured(),
        "youtube_api": bool(os.environ.get("YOUTUBE_API_KEY")),
        "server_time": datetime.now(timezone.utc).isoformat(),
    }


def _server_llm_configured() -> bool:
    try:
        from deeptutor.services.llm.config import get_llm_config

        return bool(get_llm_config().model)
    except Exception:  # noqa: BLE001
        return False


@router.post("/curriculum/outline")
async def curriculum_outline(req: OutlineRequest, _c=Depends(require_auth)) -> dict[str, Any]:
    data, model = await run_json(ANALYST_SYSTEM, build_outline_prompt(req), req.provider)
    result = normalize_outline(data)
    if not result["units"]:
        raise HTTPException(
            422,
            "No course units were found. Check that the document is a curriculum or teacher's "
            "guide (scanned pages need OCR first).",
        )
    return {**result, "model": model, "truncated": len(req.text) > MAX_DOCUMENT_CHARS}


@router.post("/curriculum/unit")
async def curriculum_unit(req: UnitDetailRequest, _c=Depends(require_auth)) -> dict[str, Any]:
    data, model = await run_json(ANALYST_SYSTEM, build_unit_prompt(req), req.provider)
    return {**normalize_unit_detail(data, req.unit.total_hours), "model": model}


@router.post("/notes")
async def notes(req: NotesRequest, _c=Depends(require_auth)) -> dict[str, Any]:
    messages = [
        {"role": "system", "content": AUTHOR_SYSTEM},
        {"role": "user", "content": build_notes_prompt(req)},
    ]
    text, model = await run_llm(messages, req.provider)
    return {"markdown": text.strip(), "model": model}


@router.post("/slides")
async def slides(req: SlidesRequest, _c=Depends(require_auth)) -> dict[str, Any]:
    messages = [
        {"role": "system", "content": AUTHOR_SYSTEM},
        {"role": "user", "content": build_slides_prompt(req)},
    ]
    text, model = await run_llm(messages, req.provider)
    return {"markdown": text.strip(), "model": model}


@router.post("/exam-format")
async def exam_format(req: ExamFormatRequest, _c=Depends(require_auth)) -> dict[str, Any]:
    data, model = await run_json(EXAMINER_SYSTEM, build_exam_format_prompt(req), req.provider)
    result = normalize_format(data)
    if not result["sections"]:
        raise HTTPException(422, "No question sections were recognised in this paper.")
    return {**result, "model": model}


@router.post("/assessment")
async def assessment(req: AssessmentRequest, _c=Depends(require_auth)) -> dict[str, Any]:
    data, model = await run_json(EXAMINER_SYSTEM, build_assessment_prompt(req), req.provider)
    paper = normalize_paper(data)
    if not paper["sections"]:
        raise HTTPException(502, "The AI did not return any questions. Try again.")
    return {**paper, "model": model}


@router.post("/questions")
async def questions(req: QuestionsRequest, _c=Depends(require_auth)) -> dict[str, Any]:
    data, model = await run_json(EXAMINER_SYSTEM, build_questions_prompt(req), req.provider)
    items = [q for q in (normalize_question(x) for x in data.get("questions") or []) if q]
    if not items:
        raise HTTPException(502, "The AI did not return any questions. Try again.")
    for q in items:
        q["topic"] = q["topic"] or req.topic.title
    return {"questions": items, "model": model}


@router.post("/solve")
async def solve(req: SolveRequest, _c=Depends(require_auth)) -> dict[str, Any]:
    messages = build_solve_messages(req)
    text, model = await run_llm(messages, req.provider)
    return {"answer": text.strip(), "model": model}


@router.post("/revise")
async def revise(req: ReviseRequest, _c=Depends(require_auth)) -> dict[str, Any]:
    prompt = "\n".join(
        [
            f"Instruction: {req.instruction}",
            f"Context: {req.context}" if req.context else "",
            "Apply the instruction to the Markdown below. Keep its structure, headings and "
            "[Source: S#] tags unless told otherwise. Reply with the revised Markdown only.",
            "",
            req.content,
        ]
    )
    messages = [{"role": "system", "content": AUTHOR_SYSTEM}, {"role": "user", "content": prompt}]
    text, model = await run_llm(messages, req.provider)
    return {"markdown": re.sub(r"^```(?:markdown)?\s*|\s*```$", "", text.strip()), "model": model}


async def _post_transcription(audio: bytes, language: str) -> str:
    """OpenAI speech-to-text (patched in tests)."""
    files = {"file": ("voice.wav", audio, "audio/wav")}
    data = {"model": os.environ.get("TUTORPRO_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe")}
    if language:
        data["language"] = language
    headers = {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY'].strip()}"}
    async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
        response = await client.post(
            f"{PROVIDERS['openai']['base']}/audio/transcriptions",
            data=data,
            files=files,
            headers=headers,
        )
    if response.status_code >= 400:
        raise HTTPException(502, "OpenAI could not transcribe the voice note.")
    return str(response.json().get("text", ""))


@router.post("/transcribe")
async def transcribe(req: TranscribeRequest, _c=Depends(require_auth)) -> dict[str, Any]:
    payload = req.audio.split(",", 1)[-1]
    try:
        audio = base64.b64decode(payload, validate=True)
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, "The voice note is not valid audio data.") from exc
    if audio[:4] != b"RIFF":
        raise HTTPException(400, "Voice notes must be sent as WAV audio.")
    available = available_providers()
    name = resolve_provider(req.provider)
    # Gemini reads audio directly; OpenAI uses its speech-to-text model.
    if name == "openai":
        text = await _post_transcription(audio, req.language)
        return {"text": text.strip(), "model": "OpenAI speech-to-text"}
    if name == "gemini" or "gemini" in available:
        body = {
            "model": provider_model("gemini"),
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "Transcribe this voice note exactly. Reply with the transcript only.",
                        },
                        {"type": "input_audio", "input_audio": {"data": payload, "format": "wav"}},
                    ],
                }
            ],
        }
        data = await _post_chat("gemini", body)
        text = data["choices"][0]["message"]["content"] or ""
        return {"text": text.strip(), "model": f"Google Gemini · {provider_model('gemini')}"}
    raise HTTPException(400, "Voice notes need GEMINI_API_KEY or OPENAI_API_KEY on the server.")


# ---------------------------------------------------------------------------
# Cloud sync: one private, versioned workspace copy per tutor
# ---------------------------------------------------------------------------


def _sync_dir() -> Path:
    root = get_current_path_service().get_user_root() / "tutorpro" / "sync"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _read_sync() -> dict[str, Any] | None:
    path = _sync_dir() / "workspace.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.exception("Tutor Pro: unreadable sync copy")
        return None


def _sync_meta(record: dict[str, Any] | None) -> dict[str, Any]:
    if not record:
        return {"rev": 0, "updated_at": None, "device": "", "sha256": "", "size": 0}
    return {k: record.get(k) for k in ("rev", "updated_at", "device", "sha256", "size")}


@router.get("/sync/meta")
async def sync_meta(_c=Depends(require_auth)) -> dict[str, Any]:
    return _sync_meta(_read_sync())


@router.get("/sync")
async def sync_get(_c=Depends(require_auth)) -> dict[str, Any]:
    record = _read_sync()
    return {**_sync_meta(record), "data": record.get("data") if record else None}


@router.put("/sync")
async def sync_put(body: SyncPut, _c=Depends(require_auth)) -> dict[str, Any]:
    raw = body.data.encode("utf-8")
    if len(raw) > MAX_SYNC_BYTES:
        raise HTTPException(413, "The workspace is too large to sync (limit 80 MB).")
    if hashlib.sha256(raw).hexdigest() != body.sha256:
        raise HTTPException(400, "The upload was damaged in transit (checksum mismatch).")
    try:
        json.loads(body.data)
    except json.JSONDecodeError as exc:
        raise HTTPException(400, "The workspace is not valid JSON.") from exc
    current = _read_sync()
    rev = int(current.get("rev", 0)) if current else 0
    if body.base_rev != rev and not body.force:
        raise HTTPException(
            409,
            detail={
                "message": "The cloud copy changed on another device.",
                **_sync_meta(current),
                "data": current.get("data") if current else None,
            },
        )
    folder = _sync_dir()
    if current and current.get("sha256") == body.sha256:
        return _sync_meta(current)
    if current:
        history = folder / "history"
        history.mkdir(exist_ok=True)
        (history / f"rev-{rev:06d}.json").write_text(json.dumps(current), encoding="utf-8")
        for old in sorted(history.glob("rev-*.json"))[:-MAX_SYNC_HISTORY]:
            old.unlink(missing_ok=True)
    record = {
        "rev": rev + 1,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "device": body.device,
        "sha256": body.sha256,
        "size": len(raw),
        "data": body.data,
    }
    tmp = folder / "workspace.json.tmp"
    tmp.write_text(json.dumps(record), encoding="utf-8")
    tmp.replace(folder / "workspace.json")
    return _sync_meta(record)


@router.get("/sync/history")
async def sync_history(_c=Depends(require_auth)) -> dict[str, Any]:
    history = _sync_dir() / "history"
    items = []
    for path in sorted(history.glob("rev-*.json"), reverse=True) if history.exists() else []:
        try:
            items.append(_sync_meta(json.loads(path.read_text(encoding="utf-8"))))
        except (OSError, json.JSONDecodeError):
            continue
    return {"items": items}


@router.get("/sync/history/{rev}")
async def sync_history_item(rev: int, _c=Depends(require_auth)) -> dict[str, Any]:
    path = _sync_dir() / "history" / f"rev-{rev:06d}.json"
    if rev < 0 or not path.exists():
        raise HTTPException(404, "That version is no longer kept.")
    record = json.loads(path.read_text(encoding="utf-8"))
    return {**_sync_meta(record), "data": record.get("data")}
