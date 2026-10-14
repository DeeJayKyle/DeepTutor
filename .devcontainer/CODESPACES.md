# DeepTutor in GitHub Codespaces (for development)

For everyday use, use the free hosted app instead — see
[deploy/huggingface/SETUP.md](../deploy/huggingface/SETUP.md). A Codespace is
for changing DeepTutor's code and testing it.

## Start it

1. Optional: add a `GEMINI_API_KEY` secret under
   **github.com → Settings → Codespaces → Secrets** (give it access to this repo),
   so the Codespace configures Gemini automatically.
2. On the repo page click **Code → Codespaces → Create codespace on main**.
3. The first build takes about 5–10 minutes. Then open the **Ports** tab and click
   the globe icon next to **DeepTutor (3782)**.

Without the secret, add a provider in **Settings → Providers** inside DeepTutor.

## Useful commands (Codespace terminal)

```bash
.venv/bin/deeptutor doctor          # health check
.venv/bin/deeptutor stop            # stop the app
bash .devcontainer/post-start.sh    # start it again
```

Free GitHub accounts get 120 core-hours/month (about 60 hours on this 2-core
machine). Stop the Codespace when you are done.
