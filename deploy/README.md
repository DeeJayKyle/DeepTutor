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

**Deep Tutor Pro** ([DeeJayKyle/Deep-Tutor-Pro](https://github.com/DeeJayKyle/Deep-Tutor-Pro))
uses this server's `/api/tutorpro` API (curriculum analysis, lecture notes,
exams, Deep Solve, cloud sync). Its web app is served at `<address>/pro/`:
each time Deep Tutor Pro publishes a release with a `deep-tutor-pro-web-*.zip`
asset, **Keep server awake** notices it and re-runs **Deploy to Cloudflare**,
which adds that build to the Worker. The installed Windows and Android apps
sign in with a bearer token from `/api/tutorpro/auth/login`; the Worker adds
CORS headers for their origins. Tutors can create their own account from the
app's sign-in screen (`/api/tutorpro/auth/register`): each gets an ordinary
user account with a private workspace and cloud copy, never an administrator
one, and sign-up is limited to 5 accounts per visitor per hour. Set the
repository variable `TUTORPRO_SELF_SIGNUP` to `0` and redeploy to close it. The
administrator login is `ADMIN_USERNAME` (default `admin`) with the
`ADMIN_PASSWORD` secret. In Deep Tutor Pro, *Settings → AI provider*
switches between Gemini and OpenAI per request when both keys are set
(`TUTORPRO_GEMINI_MODEL` / `TUTORPRO_OPENAI_MODEL` override the models).

## One-time setup: Cloudflare (free, no card)

1. Create a free account at <https://dash.cloudflare.com/sign-up> and open
   **Workers & Pages** once (this creates your `workers.dev` subdomain).
2. Open <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** →
   next to **Edit Cloudflare Workers** tap **Use template** → **Continue to
   summary** → **Create Token**, and copy the token.
3. In GitHub open **Settings → Secrets and variables → Actions → New
   repository secret**, name it `CLOUDFLARE_API_TOKEN`, paste the token, save.

The account ID is looked up automatically. Then run **Actions → Deploy to
Cloudflare → Run workflow**; the run summary shows the new address.

## Repository secrets

| Secret | Required | Purpose |
| --- | --- | --- |
| `RENDER_API_KEY` | yes | Lets the workflow create/update the Render service. |
| `ADMIN_PASSWORD` | yes | Password of the admin login (`ADMIN_USERNAME` variable, default `admin`). |
| `OPENAI_API_KEY` | one of these two | When set, the server uses OpenAI (default model `gpt-5-mini`; override with the `LLM_MODEL` variable). |
| `GEMINI_API_KEY` | one of these two | Used when no OpenAI key is set (default `gemini-flash-latest`, free tier). |
| `HF_TOKEN` | recommended | Backs up server data (accounts, school workspaces, cloud backups) to a private Hugging Face dataset, because Render's free disk is wiped on every restart. |
| `YOUTUBE_API_KEY` | optional | Enables YouTube search in the Research Assistant. Create one free in Google Cloud Console → APIs & Services → enable *YouTube Data API v3* → Credentials → API key. |
| `CLOUDFLARE_API_TOKEN` | recommended | Cloudflare address that works on mobile networks (above). `CLOUDFLARE_ACCOUNT_ID` is optional. |
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
