"""Create or update the free Render web service for online DeepTutor.

Runs in GitHub Actions. Reads secrets/variables from the environment, finds or
creates the Render service, syncs its environment variables, and deploys the
image built for this commit.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.render.com/v1"


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, "").strip() or default


def call(method: str, path: str, body: object | None = None) -> object:
    request = urllib.request.Request(
        f"{API}{path}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {env('RENDER_API_KEY')}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            text = response.read().decode()
    except urllib.error.HTTPError as exc:
        sys.exit(f"::error::Render API {method} {path} -> {exc.code}: {exc.read().decode()[:1000]}")
    return json.loads(text) if text else None


def data_repo() -> str:
    if env("DATA_REPO"):
        return env("DATA_REPO")
    if not env("HF_TOKEN"):
        return ""
    from huggingface_hub import HfApi

    return f"{HfApi(token=env('HF_TOKEN')).whoami()['name']}/deeptutor-data"


def main() -> None:
    if not env("RENDER_API_KEY"):
        print("::notice::RENDER_API_KEY secret is not set; skipping Render deploy.")
        return
    for required in ("GEMINI_API_KEY", "ADMIN_PASSWORD"):
        if not env(required):
            sys.exit(f"::error::GitHub secret {required} is required.")

    owner = env("GITHUB_REPOSITORY_OWNER", "DeeJayKyle").lower()
    image = f"ghcr.io/{owner}/deeptutor-online:{env('IMAGE_SHA', 'latest')}"
    name = env("RENDER_SERVICE_NAME", "deeptutor")

    owners = call("GET", "/owners?limit=20")
    owner_id = owners[0]["owner"]["id"]

    env_vars = {
        "PORT": "3782",
        "GEMINI_API_KEY": env("GEMINI_API_KEY"),
        "ADMIN_USERNAME": env("ADMIN_USERNAME", "admin"),
        "ADMIN_PASSWORD": env("ADMIN_PASSWORD"),
        "LLM_MODEL": env("LLM_MODEL", "gemini-flash-latest"),
        "EMBEDDING_MODEL": env("EMBEDDING_MODEL", "gemini-embedding-001"),
    }
    repo = data_repo()
    if repo:
        env_vars.update({"DATA_REPO": repo, "DATA_SYNC_TOKEN": env("HF_TOKEN")})
    env_list = [{"key": key, "value": value} for key, value in env_vars.items()]

    matches = [
        item["service"]
        for item in call("GET", f"/services?name={name}&ownerId={owner_id}&limit=20")
        if item["service"]["name"] == name
    ]
    if matches:
        service = matches[0]
        call("PUT", f"/services/{service['id']}/env-vars", env_list)
        call("POST", f"/services/{service['id']}/deploys", {"imageUrl": image})
        print(f"Updated Render service {name} -> {image}")
    else:
        created = call(
            "POST",
            "/services",
            {
                "type": "web_service",
                "name": name,
                "ownerId": owner_id,
                "image": {"ownerId": owner_id, "imagePath": image},
                "envVars": env_list,
                "serviceDetails": {
                    "runtime": "image",
                    "plan": "free",
                    "region": env("RENDER_REGION", "oregon"),
                },
            },
        )
        service = created["service"]
        print(f"Created Render service {name} from {image}")

    url = service.get("serviceDetails", {}).get("url", "")
    print(f"App URL: {url}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(
                "### DeepTutor deployed to Render\n\n"
                f"- App: {url}\n"
                f"- Dashboard: {service.get('dashboardUrl', 'https://dashboard.render.com')}\n"
                "- Startup takes about 3-4 minutes on the free tier.\n"
            )


if __name__ == "__main__":
    main()
