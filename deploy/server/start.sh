#!/bin/bash
# Server startup: restore backed-up data, apply admin login + Gemini config,
# start the periodic backup, then hand off to DeepTutor's own entrypoint.
set -e
cd /app

python /app/cloud/cloud_setup.py restore || echo "[cloud] Restore failed; starting with empty data."
python /app/cloud/cloud_setup.py configure
python /app/cloud/cloud_setup.py backup-loop &

exec /app/entrypoint.sh
