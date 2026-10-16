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

from fastapi import FastAPI  # noqa: E402
from fastapi.responses import RedirectResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
import uvicorn  # noqa: E402

from deeptutor.api.routers import companion  # noqa: E402
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


def build_app() -> FastAPI:
    companion._ai_configured = lambda: (True, "test-model")  # type: ignore[assignment]
    llm.complete = fake_complete  # type: ignore[attr-defined]
    app = FastAPI()
    app.include_router(companion.router, prefix="/api/companion")

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
