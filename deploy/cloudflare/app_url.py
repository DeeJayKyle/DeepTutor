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


def workers_dev_url() -> str:
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    if not (token and account):
        return ""
    request = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/subdomain",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            subdomain = json.load(response)["result"]["subdomain"]
    except Exception as exc:  # noqa: BLE001 — fall back to the next option
        print(f"Could not read the workers.dev subdomain: {exc}", file=sys.stderr)
        return ""
    return f"https://{wrangler_value('name')}.{subdomain}.workers.dev"


def main() -> None:
    url = os.environ.get("COMPANION_URL", "").strip() or workers_dev_url() or wrangler_value("UPSTREAM")
    print(url.rstrip("/"))


if __name__ == "__main__":
    main()
