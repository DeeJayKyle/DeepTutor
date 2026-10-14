"""Create/update the DeepTutor Hugging Face Space from GitHub Actions.

Reads GitHub secrets/variables from the environment, creates the Space if it
does not exist, syncs its secrets and variables, and uploads deploy/huggingface/space
with the Dockerfile pinned to the commit being deployed.
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
import shutil
from pathlib import Path

from huggingface_hub import HfApi

SPACE_DIR = Path(__file__).parent / "space"


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, "").strip() or default


def main() -> None:
    token = env("HF_TOKEN")
    if not token:
        print("::notice::HF_TOKEN secret is not set; skipping Hugging Face deploy.")
        return
    for required in ("GEMINI_API_KEY", "ADMIN_PASSWORD"):
        if not env(required):
            sys.exit(f"::error::GitHub secret {required} is required.")

    api = HfApi(token=token)
    owner = api.whoami()["name"]
    space_name = env("HF_SPACE_NAME", "deeptutor")
    space_id = f"{owner}/{space_name}"
    data_repo = env("HF_DATA_REPO", f"{owner}/{space_name}-data")

    api.create_repo(space_id, repo_type="space", space_sdk="docker", private=False, exist_ok=True)

    secrets = {
        "GEMINI_API_KEY": env("GEMINI_API_KEY"),
        "ADMIN_PASSWORD": env("ADMIN_PASSWORD"),
        # A separate fine-grained token (write access to the data repo only) is
        # preferred; fall back to the deploy token.
        "DATA_SYNC_TOKEN": env("HF_DATA_TOKEN", token),
    }
    variables = {
        "ADMIN_USERNAME": env("ADMIN_USERNAME", "admin"),
        "LLM_MODEL": env("LLM_MODEL", "gemini-2.5-flash"),
        "EMBEDDING_MODEL": env("EMBEDDING_MODEL", "gemini-embedding-001"),
        "DATA_REPO": data_repo,
        "DATA_SYNC_MINUTES": env("DATA_SYNC_MINUTES", "5"),
    }
    for key, value in secrets.items():
        api.add_space_secret(space_id, key, value)
    for key, value in variables.items():
        api.add_space_variable(space_id, key, value)

    repo = f"https://github.com/{env('GITHUB_REPOSITORY', 'DeeJayKyle/DeepTutor')}.git"
    ref = env("GITHUB_SHA", "main")
    with tempfile.TemporaryDirectory() as tmp:
        staged = Path(tmp) / "space"
        shutil.copytree(SPACE_DIR, staged)
        dockerfile = staged / "Dockerfile"
        text = dockerfile.read_text(encoding="utf-8")
        text = re.sub(r"^ARG SOURCE_REPO=.*$", f"ARG SOURCE_REPO={repo}", text, flags=re.M)
        text = re.sub(r"^ARG SOURCE_REF=.*$", f"ARG SOURCE_REF={ref}", text, flags=re.M)
        dockerfile.write_text(text, encoding="utf-8")
        api.upload_folder(
            folder_path=staged,
            repo_id=space_id,
            repo_type="space",
            commit_message=f"Deploy {ref[:7]} from GitHub",
        )

    host = re.sub(r"[^a-z0-9-]", "-", f"{owner}-{space_name}".lower())
    url = f"https://{host}.hf.space"
    print(f"Deployed {space_id} (commit {ref[:7]}).")
    print(f"App URL: {url}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(
                f"### DeepTutor deployed\n\n"
                f"- App: {url}\n"
                f"- Build logs: https://huggingface.co/spaces/{space_id}?logs=build\n"
                f"- The first build takes ~10-20 minutes.\n"
            )


if __name__ == "__main__":
    main()
