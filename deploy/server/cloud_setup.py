"""Cloud startup helpers for the online DeepTutor server.

restore      Pull /app/data from a private Hugging Face dataset (free hosts have no
             persistent disk, and Render's free tier restarts after every idle sleep).
configure    Lock the app behind the admin account and point it at Gemini.
backup-loop  Push /app/data back to the dataset whenever it changes.

Configuration comes from environment variables set by deploy/render/deploy.py:
  ADMIN_USERNAME, ADMIN_PASSWORD, GEMINI_API_KEY, LLM_MODEL, EMBEDDING_MODEL,
  DATA_REPO, DATA_SYNC_TOKEN, DATA_SYNC_MINUTES
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

APP = Path("/app")
DATA = APP / "data"
TOKEN = os.environ.get("DATA_SYNC_TOKEN", "").strip()
DATA_REPO = os.environ.get("DATA_REPO", "").strip()
# Runtime scratch, logs and caches are not worth backing up.
IGNORE = [
    ".cache/*",
    "user/logs/*",
    "user/runtime/*",
    "*/__pycache__/*",
    "*.lock",
    "*.pid",
    "*.sock",
]


def log(message: str) -> None:
    print(f"[cloud] {message}", flush=True)


def _backup_enabled() -> bool:
    return bool(TOKEN and DATA_REPO)


def restore() -> None:
    if not _backup_enabled():
        log(
            "Data backup is off (DATA_SYNC_TOKEN/DATA_REPO not set): chats reset when the Space restarts."
        )
        return
    from huggingface_hub import HfApi, snapshot_download

    api = HfApi(token=TOKEN)
    api.create_repo(DATA_REPO, repo_type="dataset", private=True, exist_ok=True)
    if not api.list_repo_files(DATA_REPO, repo_type="dataset"):
        log(f"Backup dataset {DATA_REPO} is empty; starting fresh.")
        return
    snapshot_download(DATA_REPO, repo_type="dataset", local_dir=DATA, token=TOKEN)
    log(f"Restored data from {DATA_REPO}.")


def _configure_auth() -> None:
    username = os.environ.get("ADMIN_USERNAME", "").strip() or "admin"
    password = os.environ.get("ADMIN_PASSWORD", "")
    if len(password) < 8:
        # A public Space without a fixed admin would let the first visitor claim it.
        sys.exit(
            "[cloud] ADMIN_PASSWORD secret is missing or shorter than 8 characters; refusing to start."
        )

    from deeptutor.services.auth import hash_password, verify_password
    from deeptutor.services.config.runtime_settings import get_runtime_settings_service

    service = get_runtime_settings_service()
    current = service.load_auth(include_process_overrides=False)
    password_hash = current.get("password_hash") or ""
    if (
        current.get("username") != username
        or not password_hash
        or not verify_password(password, password_hash)
    ):
        password_hash = hash_password(password)
    service.save_auth(
        {
            **current,
            "enabled": True,
            "username": username,
            "password_hash": password_hash,
            "cookie_secure": True,
        }
    )
    log(f"Login enabled for admin '{username}'.")


def _configure_models() -> None:
    # OpenAI is used when its key is present; otherwise Gemini (free tier).
    if os.environ.get("OPENAI_API_KEY", "").strip():
        provider, key_env = "openai", "OPENAI_API_KEY"
        llm_default, embed_default = "gpt-5-mini", "text-embedding-3-small"
    elif os.environ.get("GEMINI_API_KEY", "").strip():
        provider, key_env = "gemini", "GEMINI_API_KEY"
        llm_default, embed_default = "gemini-flash-latest", "gemini-embedding-001"
    else:
        log("No OPENAI_API_KEY or GEMINI_API_KEY; add a model provider in Settings -> Providers.")
        return
    setup = {
        "llm": {
            "provider": provider,
            "model": os.environ.get("LLM_MODEL", "").strip() or llm_default,
            "api_key_env": key_env,
        },
        "embedding": {
            "provider": provider,
            "model": os.environ.get("EMBEDDING_MODEL", "").strip() or embed_default,
            "api_key_env": key_env,
        },
        "search": {"provider": "duckduckgo"},
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as handle:
        json.dump(setup, handle)
        path = handle.name
    try:
        result = subprocess.run(
            [sys.executable, "-m", "deeptutor_cli", "config", "apply", path, "--home", str(APP)],
            cwd=APP,
            capture_output=True,
            text=True,
        )
    finally:
        os.unlink(path)
    if result.returncode == 0:
        log(
            f"Models configured: {setup['llm']['model']} + {setup['embedding']['model']} ({provider})."
        )
    else:
        log(f"Automatic model setup failed; configure {provider} in Settings -> Providers.")
        log((result.stdout + result.stderr).strip()[-2000:])


def configure() -> None:
    sys.path.insert(0, str(APP))
    os.chdir(APP)
    from deeptutor.services.setup import init_user_directories

    init_user_directories(APP)
    _configure_auth()
    _configure_models()


def _fingerprint() -> str:
    entries = []
    for path in sorted(DATA.rglob("*")):
        if path.is_file():
            rel = path.relative_to(DATA).as_posix()
            stat = path.stat()
            entries.append(f"{rel}:{stat.st_size}:{int(stat.st_mtime)}")
    return "\n".join(entries)


def backup_loop() -> None:
    if not _backup_enabled():
        return
    from huggingface_hub import HfApi

    api = HfApi(token=TOKEN)
    interval = max(1, int(os.environ.get("DATA_SYNC_MINUTES", "5") or 5)) * 60
    last = _fingerprint()
    while True:
        time.sleep(interval)
        current = _fingerprint()
        if current == last:
            continue
        try:
            api.upload_folder(
                folder_path=DATA,
                repo_id=DATA_REPO,
                repo_type="dataset",
                ignore_patterns=IGNORE,
                delete_patterns="*",
                commit_message="DeepTutor data backup",
            )
            last = current
            log("Backed up data.")
        except Exception as exc:  # keep the loop alive; retry next interval
            log(f"Backup failed: {exc}")


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    {"restore": restore, "configure": configure, "backup-loop": backup_loop}[command]()
