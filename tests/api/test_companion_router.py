"""Tutor Companion router tests, driven through a real ASGI client."""

from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from deeptutor.api.routers import companion
from deeptutor.services.path_service import PathService


@pytest.fixture
def client(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("DEEPTUTOR_HOME", str(tmp_path))
    PathService.reset_instance()
    app = FastAPI()
    app.include_router(companion.router, prefix="/api/companion")
    with TestClient(app) as test_client:
        yield test_client
    PathService.reset_instance()


def _backup_body(stores: dict, label: str = "Weekly") -> dict:
    payload = json.dumps({"schema": 1, "stores": stores})
    return {
        "label": label,
        "device": "test",
        "sha256": hashlib.sha256(payload.encode()).hexdigest(),
        "payload": payload,
    }


def test_build_prompt_includes_context_sources_and_marking_guide():
    req = companion.GenerateRequest(
        kind="exam",
        class_name="Diploma in Pharmacy - Year One",
        unit_title="Pharmacology I",
        unit_code="PHA101",
        topics=["Pharmacokinetics", "Drug receptors"],
        sources=[
            companion.SourceExcerpt(title="Rang & Dale ch.2", text="Absorption depends on...")
        ],
        total_marks=100,
        num_questions=10,
        duration="3 hours",
    )
    prompt = companion.build_prompt(req)
    assert "PHA101 Pharmacology I" in prompt
    assert "Pharmacokinetics; Drug receptors" in prompt
    assert "--- S1: Rang & Dale ch.2 ---" in prompt
    assert "Total marks: 100" in prompt
    assert "# Marking Guide" in prompt


def test_build_prompt_without_sources_marks_everything_ai_generated():
    prompt = companion.build_prompt(
        companion.GenerateRequest(kind="lecture_notes", topics=["Cells"])
    )
    assert "No source materials were supplied" in prompt
    assert "SOURCE MATERIALS" not in prompt


def test_generate_reports_missing_ai(client, monkeypatch):
    monkeypatch.setattr(companion, "_ai_configured", lambda: (False, ""))
    response = client.post("/api/companion/generate", json={"kind": "quiz"})
    assert response.status_code == 503


def test_generate_returns_model_output(client, monkeypatch):
    monkeypatch.setattr(companion, "_ai_configured", lambda: (True, "fake-model"))
    seen = {}

    async def fake_complete(prompt, system_prompt=""):
        seen["prompt"] = prompt
        seen["system"] = system_prompt
        return "# Quiz\n1. What is a cell? (2 marks)"

    import deeptutor.services.llm as llm

    monkeypatch.setattr(llm, "complete", fake_complete, raising=False)
    response = client.post(
        "/api/companion/generate",
        json={
            "kind": "quiz",
            "topics": ["Cells"],
            "sources": [{"title": "Bio", "text": "Cells are..."}],
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["content"].startswith("# Quiz")
    assert body["sources_used"] == ["Bio"]
    assert body["ai_generated"] is True
    assert "Never invent citations" in seen["system"]


def test_extract_text_and_docx(client):
    response = client.post(
        "/api/companion/extract",
        files={"file": ("outline.txt", io.BytesIO(b"Week 1: Cells\n\n\n\nWeek 2"), "text/plain")},
    )
    assert response.status_code == 200
    assert response.json()["text"] == "Week 1: Cells\n\nWeek 2"

    docx = pytest.importorskip("docx")
    document = docx.Document()
    document.add_paragraph("Learning outcome: explain absorption")
    buffer = io.BytesIO()
    document.save(buffer)
    response = client.post(
        "/api/companion/extract",
        files={
            "file": ("curriculum.docx", io.BytesIO(buffer.getvalue()), "application/octet-stream")
        },
    )
    assert response.status_code == 200
    assert "explain absorption" in response.json()["text"]


def test_extract_rejects_unsupported_and_corrupted(client):
    bad = client.post("/api/companion/extract", files={"file": ("x.exe", io.BytesIO(b"MZ"), "x")})
    assert bad.status_code == 415
    corrupted = client.post(
        "/api/companion/extract", files={"file": ("broken.docx", io.BytesIO(b"not a zip"), "x")}
    )
    assert corrupted.status_code == 422


def test_backup_roundtrip_and_integrity(client):
    stores = {"classes": [{"id": "c1", "name": "Pharmacy Y1"}], "students": []}
    created = client.post("/api/companion/backups", json=_backup_body(stores))
    assert created.status_code == 201, created.text
    summary = created.json()
    assert summary["counts"] == {"classes": 1, "students": 0}

    listing = client.get("/api/companion/backups").json()["backups"]
    assert [b["id"] for b in listing] == [summary["id"]]

    record = client.get(f"/api/companion/backups/{summary['id']}").json()
    assert json.loads(record["payload"])["stores"] == stores

    assert client.delete(f"/api/companion/backups/{summary['id']}").status_code == 200
    assert client.get("/api/companion/backups").json()["backups"] == []


def test_backup_rejects_corrupted_payload_and_bad_ids(client):
    body = _backup_body({"classes": []})
    body["payload"] = body["payload"].replace("classes", "klasses")
    assert client.post("/api/companion/backups", json=body).status_code == 400
    assert client.get("/api/companion/backups/..%2Fsecrets").status_code in {400, 404}
    assert client.get("/api/companion/backups/not-an-id").status_code == 400


def test_parsers_keep_real_metadata():
    openalex = companion.parse_openalex(
        {
            "results": [
                {
                    "display_name": "Drug absorption",
                    "doi": "https://doi.org/10.1/abc",
                    "publication_date": "2020-01-02",
                    "authorships": [{"author": {"display_name": "A. Author"}}],
                    "primary_location": {"source": {"display_name": "J. Pharm"}},
                    "abstract_inverted_index": {"Absorption": [0], "matters": [1]},
                }
            ]
        }
    )
    assert openalex[0]["url"] == "https://doi.org/10.1/abc"
    assert openalex[0]["summary"] == "Absorption matters"
    assert openalex[0]["source"] == "J. Pharm"

    commons = companion.parse_commons(
        {
            "query": {
                "pages": {
                    "1": {
                        "title": "File:Heart.svg",
                        "index": 1,
                        "imageinfo": [
                            {
                                "url": "https://upload.wikimedia.org/heart.svg",
                                "descriptionurl": "https://commons.wikimedia.org/wiki/File:Heart.svg",
                                "extmetadata": {
                                    "LicenseShortName": {"value": "CC BY-SA 4.0"},
                                    "Artist": {"value": "<a href='x'>Jane</a>"},
                                },
                            }
                        ],
                    }
                }
            }
        }
    )
    assert commons[0]["license"] == "CC BY-SA 4.0"
    assert commons[0]["author"] == "Jane"

    youtube = companion.parse_youtube(
        {"items": [{"id": {"videoId": "abc"}, "snippet": {"title": "Pharmacokinetics"}}]}
    )
    assert youtube[0]["url"] == "https://www.youtube.com/watch?v=abc"


def test_videos_without_api_key_return_search_link(client, monkeypatch):
    monkeypatch.delenv("YOUTUBE_API_KEY", raising=False)
    response = client.post(
        "/api/companion/research", json={"query": "pharmacokinetics", "kind": "videos"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["results"] == []
    assert body["search_url"].endswith("pharmacokinetics")
