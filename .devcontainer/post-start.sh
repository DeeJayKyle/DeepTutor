#!/usr/bin/env bash
# Runs every time the Codespace starts or resumes: bring up Ollama, then DeepTutor.
set -euo pipefail
cd "$(dirname "$0")/.."

bash .devcontainer/start-ollama.sh || true
.venv/bin/deeptutor start --detach --no-browser --home "$DEEPTUTOR_HOME"
echo "DeepTutor is starting. Open the 'DeepTutor' entry in the Ports tab (port 3782)."
