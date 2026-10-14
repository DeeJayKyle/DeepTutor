#!/usr/bin/env bash
# One-time Codespace setup: Ollama (local model), DeepTutor backend + web, default config.
set -euo pipefail
cd "$(dirname "$0")/.."

OLLAMA_VERSION="v0.40.4"

echo "==> Installing Ollama ${OLLAMA_VERSION} from GitHub releases"
sudo apt-get update -qq && sudo apt-get install -y -qq zstd >/dev/null
curl -fsSL "https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}/ollama-linux-amd64.tar.zst" \
  | zstd -d | sudo tar -x -C /usr/local

echo "==> Installing DeepTutor (Python backend)"
python -m venv .venv
.venv/bin/python -m pip install --upgrade pip -q
.venv/bin/python -m pip install -e . -q

echo "==> Installing DeepTutor web frontend"
(cd web && npm ci --legacy-peer-deps --no-audit --no-fund)

echo "==> Initialising DeepTutor settings in ${DEEPTUTOR_HOME}"
mkdir -p "$DEEPTUTOR_HOME" "$OLLAMA_MODELS"
.venv/bin/deeptutor init --non-interactive --home "$DEEPTUTOR_HOME"

echo "==> Downloading local models (${DEEPTUTOR_LLM_MODEL}, ${DEEPTUTOR_EMBED_MODEL})"
bash .devcontainer/start-ollama.sh
ollama pull "$DEEPTUTOR_LLM_MODEL"
ollama pull "$DEEPTUTOR_EMBED_MODEL"

echo "==> Pointing DeepTutor at the local models"
cat > "$DEEPTUTOR_HOME/codespace-setup.json" <<EOF
{
  "llm": { "provider": "ollama", "model": "${DEEPTUTOR_LLM_MODEL}" },
  "embedding": { "provider": "ollama", "model": "${DEEPTUTOR_EMBED_MODEL}", "dimension": 768 },
  "search": { "provider": "duckduckgo" }
}
EOF
if .venv/bin/deeptutor config apply "$DEEPTUTOR_HOME/codespace-setup.json" --check --home "$DEEPTUTOR_HOME"; then
  .venv/bin/deeptutor config apply "$DEEPTUTOR_HOME/codespace-setup.json" --home "$DEEPTUTOR_HOME"
else
  echo "!! Automatic model config was rejected; pick Ollama in Settings -> Providers instead."
fi

echo "Setup complete. DeepTutor starts automatically on port 3782 (the first start builds the web app)."
