"""Print the public address of Tutor Companion's server.

Order: the COMPANION_URL variable if set; otherwise the Cloudflare Worker's
workers.dev address (when CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are
available); otherwise the Render address from wrangler.toml.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sys
import urllib.request

HERE = Path(__file__).resolve().parent


def wrangler_value(key: str) -> str:
    match = re.search(rf'^\s*{key}\s*=\s*"([^"]+)"', (HERE / "wrangler.toml").read_text(), re.M)
    return match.group(1) if match else ""


def _cloudflare(path: str, token: str) -> dict:
    request = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4{path}",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def account_id() -> str:
    """The account from CLOUDFLARE_ACCOUNT_ID, or the token's only account."""
    explicit = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if explicit or not token:
        return explicit
    try:
        accounts = _cloudflare("/accounts", token)["result"]
    except Exception as exc:  # noqa: BLE001
        print(f"Could not list Cloudflare accounts: {exc}", file=sys.stderr)
        return ""
    return accounts[0]["id"] if accounts else ""


def workers_dev_url() -> str:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    account = account_id()
    if not (token and account):
        return ""
    try:
        subdomain = _cloudflare(f"/accounts/{account}/workers/subdomain", token)["result"][
            "subdomain"
        ]
    except Exception as exc:  # noqa: BLE001 — fall back to the next option
        print(f"Could not read the workers.dev subdomain: {exc}", file=sys.stderr)
        return ""
    return f"https://{wrangler_value('name')}.{subdomain}.workers.dev"


def main() -> None:
    if sys.argv[1:] == ["--account-id"]:
        print(account_id())
        return
    url = (
        os.environ.get("COMPANION_URL", "").strip()
        or workers_dev_url()
        or wrangler_value("UPSTREAM")
    )
    print(url.rstrip("/"))


if __name__ == "__main__":
    main()
