# Online deployment (GitHub Actions → Render, served through Cloudflare)

Everything is built and deployed by GitHub Actions — nothing needs to be
installed on your computer.

1. **`Build server image`** builds `deploy/server/Dockerfile` on every push to
   `main` that touches `web/`, `deeptutor/` or `deploy/server/`.
2. **`Deploy to Render`** runs that image on a free Render web service.
3. **`Deploy to Cloudflare`** publishes a Cloudflare Worker
   (`deploy/cloudflare/worker.js`) that serves the same site from
   `https://tutor-companion.<your-account>.workers.dev`. Some mobile networks
   cannot open `*.onrender.com`; the Cloudflare address works on them.
4. **`Keep server awake`** pings the server every 10 minutes so it does not
   fall asleep (a cold start takes minutes, which phones give up on).
5. **`Release Tutor Companion`** (run manually) builds the signed Windows
   installer and Android APK and publishes a GitHub release.

Tutor Companion is at `<address>/companion`; DeepTutor itself at `<address>/`.

## One-time setup: Cloudflare (free, no card)

1. Create a free account at <https://dash.cloudflare.com/sign-up>.
2. Open **Workers & Pages** once — this creates your `workers.dev` subdomain.
   Copy the **Account ID** shown on that page.
3. Go to **My Profile → API Tokens → Create Token**, choose the template
   **Edit Cloudflare Workers**, then **Continue → Create Token**, and copy it.
4. In GitHub: **Settings → Secrets and variables → Actions → New repository
   secret**, add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
5. Run **Actions → Deploy to Cloudflare → Run workflow**. The run summary shows
   the new address.

## Repository secrets

| Secret | Required | Purpose |
| --- | --- | --- |
| `RENDER_API_KEY` | yes | Lets the workflow create/update the Render service. |
| `ADMIN_PASSWORD` | yes | Password of the admin login (`ADMIN_USERNAME` variable, default `admin`). |
| `OPENAI_API_KEY` | one of these two | When set, the server uses OpenAI (default model `gpt-5-mini`; override with the `LLM_MODEL` variable). |
| `GEMINI_API_KEY` | one of these two | Used when no OpenAI key is set (default `gemini-flash-latest`, free tier). |
| `HF_TOKEN` | recommended | Backs up server data (accounts, school workspaces, cloud backups) to a private Hugging Face dataset, because Render's free disk is wiped on every restart. |
| `YOUTUBE_API_KEY` | optional | Enables YouTube search in the Research Assistant. Create one free in Google Cloud Console → APIs & Services → enable *YouTube Data API v3* → Credentials → API key. |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | recommended | Cloudflare address that works on mobile networks (above). |
| `WINDOWS_CERT_PFX_BASE64`, `WINDOWS_CERT_PASSWORD` | optional | A purchased code-signing certificate (`.pfx`, base64-encoded) so Windows shows your name instead of *Unknown publisher*. Without it the installer is signed with a self-signed certificate. |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | optional | A permanent Android signing key, so every future APK installs as an update. Without it each build uses a temporary key. |

After adding or changing `OPENAI_API_KEY`, `GEMINI_API_KEY` or
`YOUTUBE_API_KEY`, run **Actions → Deploy to Render → Run workflow** so the
server picks them up. If you switch provider, update or delete `LLM_MODEL` /
`EMBEDDING_MODEL` so they name models of the new provider.

## Repository variables (optional)

`ADMIN_USERNAME`, `RENDER_SERVICE_NAME` (default `deeptutor`), `RENDER_REGION`
(default `oregon`), `LLM_MODEL`, `EMBEDDING_MODEL`, `DATA_REPO`, and
`COMPANION_URL` (forces the address the apps use, e.g. your own domain).

## Notes

- API keys stay on the server; they are never sent to browsers or apps.
- Cloudflare's free plan allows 100,000 requests a day.
- GitHub pauses scheduled workflows after 60 days without repository activity;
  re-enable **Keep server awake** from the Actions tab if that happens.
