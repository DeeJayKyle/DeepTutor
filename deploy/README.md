# Online deployment (Render + GitHub Actions)

Everything is built and deployed by GitHub Actions — nothing needs to be
installed on your computer.

1. **`Build server image`** (`.github/workflows/server-image.yml`) builds
   `deploy/server/Dockerfile` on every push to `main` that touches `web/`,
   `deeptutor/` or `deploy/server/`, and pushes it to GHCR.
2. **`Deploy to Render`** (`.github/workflows/deploy-render.yml`) then
   creates or updates a free Render web service running that image.

The deployed site serves DeepTutor at `/` and **Tutor Companion** at
`/companion` (see `docs/tutor-companion.md`).

## Repository secrets (Settings → Secrets and variables → Actions)

| Secret | Required | Purpose |
| --- | --- | --- |
| `RENDER_API_KEY` | yes | Lets the workflow create/update the Render service. |
| `ADMIN_PASSWORD` | yes | Password of the admin login (username from the `ADMIN_USERNAME` variable, default `admin`). |
| `OPENAI_API_KEY` | one of these two | When set, the server uses OpenAI (default model `gpt-5-mini`). |
| `GEMINI_API_KEY` | one of these two | Used when no OpenAI key is set (default `gemini-flash-latest`, free tier). |
| `HF_TOKEN` | recommended | Backs up server data (accounts, settings, Tutor Companion cloud backups) to a private Hugging Face dataset, because Render's free disk is wiped on every restart. |
| `YOUTUBE_API_KEY` | optional | Enables YouTube search in the Tutor Companion Research Assistant. Without it the app offers a YouTube search link instead. |

## Repository variables (optional)

`ADMIN_USERNAME`, `RENDER_SERVICE_NAME` (default `deeptutor`), `RENDER_REGION`
(default `oregon`), `LLM_MODEL`, `EMBEDDING_MODEL`, `DATA_REPO`.

If you switch provider, update or delete `LLM_MODEL` / `EMBEDDING_MODEL` so
they name models of the new provider.

## Notes

- API keys stay on the server; they are never sent to browsers or apps.
- The free Render tier sleeps after inactivity; the first request after a
  sleep takes about a minute. Tutor Companion keeps working from its offline
  copy meanwhile.
- To deploy manually: Actions → *Build server image* → *Run workflow*.
