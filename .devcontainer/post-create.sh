#!/usr/bin/env bash
# One-time Codespace setup: DeepTutor backend + web, default config.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Installing DeepTutor (Python backend)"
python -m venv .venv
.venv/bin/python -m pip install --upgrade pip -q
.venv/bin/python -m pip install -e . -q

echo "==> Installing DeepTutor web frontend"
(cd web && npm ci --legacy-peer-deps --no-audit --no-fund)

echo "==> Initialising DeepTutor settings in ${DEEPTUTOR_HOME}"
mkdir -p "$DEEPTUTOR_HOME"
.venv/bin/deeptutor init --non-interactive --home "$DEEPTUTOR_HOME"

# With a GEMINI_API_KEY Codespaces secret, point DeepTutor at Gemini automatically.
if [ -n "${GEMINI_API_KEY:-}" ]; then
  echo "==> Configuring Gemini"
  cat > "$DEEPTUTOR_HOME/codespace-setup.json" <<'EOF'
{
  "llm": { "provider": "gemini", "model": "gemini-2.5-flash", "api_key_env": "GEMINI_API_KEY" },
  "embedding": { "provider": "gemini", "model": "gemini-embedding-001", "api_key_env": "GEMINI_API_KEY" },
  "search": { "provider": "duckduckgo" }
}
EOF
  .venv/bin/deeptutor config apply "$DEEPTUTOR_HOME/codespace-setup.json" --home "$DEEPTUTOR_HOME" \
    || echo "!! Automatic model config was rejected; add a provider in Settings -> Providers."
else
  echo "No GEMINI_API_KEY secret; add a model provider in Settings -> Providers."
fi

echo "Setup complete. DeepTutor starts automatically on port 3782 (the first start builds the web app)."
