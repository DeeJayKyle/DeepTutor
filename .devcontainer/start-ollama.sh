#!/usr/bin/env bash
# Start the Ollama server in the background (no-op if it is already up).
set -euo pipefail

if curl -fs http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  exit 0
fi
nohup ollama serve >/tmp/ollama.log 2>&1 &
for _ in $(seq 1 30); do
  curl -fs http://127.0.0.1:11434/api/version >/dev/null 2>&1 && exit 0
  sleep 1
done
echo "Ollama did not start; see /tmp/ollama.log" >&2
exit 1
