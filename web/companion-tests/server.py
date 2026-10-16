"""Test server for Tutor Companion end-to-end tests.

Serves web/public as static files and mounts the real companion API router,
with a deterministic stand-in for the LLM so tests never call a paid service.

    python companion-tests/server.py --port 8765
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("DEEPTUTOR_HOME", tempfile.mkdtemp(prefix="tc-e2e-"))

from contextvars import ContextVar  # noqa: E402
import io  # noqa: E402

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import RedirectResponse, Response  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
import uvicorn  # noqa: E402

from deeptutor.api.routers import companion, companion_schools  # noqa: E402
import deeptutor.services.llm as llm  # noqa: E402

LECTURE = """# Pharmacokinetics

## Learning objectives
- Explain drug absorption [Source: S1]
- Describe distribution

## Absorption
Absorption is the movement of a drug into the bloodstream [Source: S1].

> AI-generated explanation: oral drugs pass through the gut wall first.

| Route | Onset |
| --- | --- |
| IV | Immediate |
| Oral | 30-60 min |

## Summary
1. Absorption depends on route [Source: S1]
2. Review the key terms
"""

QUIZ = """# Quiz: Pharmacokinetics

1. Which organ metabolises most drugs? (1 mark)
A) Kidney
B) Liver
C) Heart
D) Lung

2. Define half-life. (2 marks)

# Marking Guide
1. Answer: B — the liver metabolises most drugs.
2. The time taken for plasma concentration to fall by half.
"""

SLIDES = """## Pharmacokinetics
- What the body does to a drug
- ADME overview
Notes: Introduce the topic.

## Absorption
- Route matters
- Bioavailability
"""


async def fake_complete(prompt: str, system_prompt: str = "", **_: object) -> str:
    task = prompt.split("\n", 1)[0]
    if "quiz" in task.lower() or "examination" in task.lower():
        return QUIZ
    if "slide deck" in task.lower():
        return SLIDES
    if task.startswith("TASK: Revise"):
        return LECTURE.replace("# Pharmacokinetics", "# Pharmacokinetics (revised)")
    return LECTURE


TEST_USER: ContextVar[str] = ContextVar("tc_test_user", default="tutor-a")


class FakeDeepTutor:
    """Stands in for DeepTutor's runtime: streams events like a real turn."""

    async def start_turn(self, payload):
        self.payload = payload
        return {"id": "session-1"}, {"id": "turn-1"}

    async def stream_turn(self, turn_id):
        cap = self.payload["capability"]
        yield {"type": "stage_start", "metadata": {"stage": "responding"}}
        for chunk in [
            f"**{cap}** answer: ",
            "first-pass metabolism ",
            "reduces oral bioavailability.",
        ]:
            yield {
                "type": "content",
                "content": chunk,
                "metadata": {"call_id": "c1", "trace_kind": "llm_chunk"},
            }
        yield {
            "type": "sources",
            "metadata": {
                "sources": [{"title": "Pharmacology textbook", "url": "https://example.org/pk"}]
            },
        }
        yield {"type": "done", "metadata": {}}

    async def submit_user_reply(self, turn_id, text=""):
        return True

    async def cancel_turn(self, turn_id):
        return True


def scanned_pdf() -> bytes:
    """A PDF whose only page is an image of text (no text layer)."""
    from PIL import Image, ImageDraw, ImageFont
    import pymupdf

    img = Image.new("RGB", (1240, 400), "white")
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", 64)
    except OSError:
        font = ImageFont.load_default(size=64)
    draw.text((60, 80), "Bioavailability", fill="black", font=font)
    draw.text((60, 200), "Absorption rate", fill="black", font=font)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    doc = pymupdf.open()
    page = doc.new_page(width=620, height=200)
    page.insert_image(page.rect, stream=buf.getvalue())
    data = doc.tobytes()
    doc.close()
    return data


def build_app() -> FastAPI:
    companion._ai_configured = lambda: (True, "test-model")  # type: ignore[assignment]
    companion._deeptutor_app = FakeDeepTutor  # type: ignore[assignment]
    companion_schools._username = lambda: TEST_USER.get()  # type: ignore[assignment]
    companion_schools._account_exists = lambda name: True  # type: ignore[assignment]
    llm.complete = fake_complete  # type: ignore[attr-defined]
    app = FastAPI()

    @app.middleware("http")
    async def test_user(request: Request, call_next):
        token = TEST_USER.set(request.headers.get("x-test-user", "tutor-a"))
        try:
            return await call_next(request)
        finally:
            TEST_USER.reset(token)

    app.include_router(companion_schools.router, prefix="/api/companion/schools")
    app.include_router(companion.router, prefix="/api/companion")

    @app.get("/api/knowledge-bases/list")
    async def kb_list() -> list[dict]:
        return [
            {
                "id": "pharm-kb",
                "name": "pharm-kb",
                "is_default": False,
                "statistics": {},
                "status": "ready",
            }
        ]

    @app.get("/__fixtures/scanned.pdf")
    async def scanned() -> Response:
        return Response(scanned_pdf(), media_type="application/pdf")

    @app.get("/companion")
    async def companion_root() -> RedirectResponse:
        return RedirectResponse("/companion/index.html")

    app.mount("/", StaticFiles(directory=ROOT / "web" / "public", html=True), name="public")
    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    uvicorn.run(build_app(), host="127.0.0.1", port=args.port, log_level="warning")
