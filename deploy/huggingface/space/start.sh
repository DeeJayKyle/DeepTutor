#!/bin/bash
# Space startup: restore backed-up data, apply admin login + Gemini config,
# start the periodic backup, then hand off to DeepTutor's own entrypoint.
set -e
cd /app

python /app/hf/space_setup.py restore || echo "[space] Restore failed; starting with empty data."
python /app/hf/space_setup.py configure
python /app/hf/space_setup.py backup-loop &

exec /app/entrypoint.sh
