# Free online DeepTutor (web, Android, PC)

This fork deploys DeepTutor to a free **Hugging Face Space** every time `main`
changes. It runs on Google **Gemini**'s free tier, is locked behind your own
admin login, and can be installed as an app on Android and PC.

Everything here is free and needs no credit card.

## One-time setup (about 10 minutes)

### 1. Get the three free keys

| What | Where | Notes |
| --- | --- | --- |
| Hugging Face token | Create a free account at [huggingface.co](https://huggingface.co/join), then **Settings → Access Tokens → Create new token → Write** | Lets GitHub create and update your Space |
| Gemini API key | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → **Create API key** | Free tier, no card |
| Admin password | Make one up (8+ characters) | You log in to DeepTutor with this |

### 2. Save them as GitHub secrets

In this repo: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret name | Value |
| --- | --- |
| `HF_TOKEN` | the Hugging Face token |
| `GEMINI_API_KEY` | the Gemini key |
| `ADMIN_PASSWORD` | your admin password |

Optional **variables** (same page, *Variables* tab): `ADMIN_USERNAME`
(default `admin`), `LLM_MODEL` (default `gemini-2.5-flash`), `HF_SPACE_NAME`
(default `deeptutor`).

### 3. Deploy

**Actions → Deploy to Hugging Face → Run workflow.** The run summary prints your
app address, `https://<your-hf-username>-deeptutor.hf.space`. The first build
takes about 10–20 minutes; watch it from the build-logs link in the summary.

## Use it everywhere

Sign in with your admin username and password at your app address.

- **Web:** any browser, any device.
- **Android:** open the address in Chrome → **⋮ → Add to Home screen / Install app**.
- **PC:** open it in Chrome or Edge → click the **Install** icon in the address bar
  (or **⋮ → Cast, save and share → Install page as app**).
- **iPhone/iPad:** Safari → **Share → Add to Home Screen**.

Always use the `*.hf.space` address, not the `huggingface.co/spaces/...` page —
the embedded view blocks login cookies.

Add other people from **/admin/users** inside DeepTutor; they never see your API key.

## What to know about the free tier

- **Sleep:** a Space with no visitors for 48 hours goes to sleep; the next visit
  wakes it in a minute or two.
- **Your data** (chats, knowledge bases, settings) is backed up every 5 minutes to a
  private Hugging Face dataset, `<your-hf-username>/deeptutor-data`, and restored
  when the Space restarts. Changes from the last few minutes before a restart can be lost.
- **Gemini free tier** has per-minute and per-day request limits. Heavy features
  (Deep Research, large knowledge bases) can hit them; switch `LLM_MODEL` to
  `gemini-2.5-flash-lite` for higher limits, or add another provider in
  **Settings → Providers**.
- The Space itself is public (anyone can see the login page and its source files),
  but only accounts you create can sign in. Secrets stay hidden.

## Updating

Any push to `main` that touches `web/` or `deploy/huggingface/` redeploys
automatically, as does re-running the workflow. To update DeepTutor itself, sync
the fork with upstream and change `DEEPTUTOR_IMAGE` in
`deploy/huggingface/space/Dockerfile` to the matching release.
