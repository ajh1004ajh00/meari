#!/bin/bash
# Starts the Nemotron engine (if not already up or loading) and the web app on http://localhost:8020
APP="$(cd "$(dirname "$0")/.." && pwd)"
VENV=${MEARI_NEMO_DIR:-/root/nemo-speech}/.venv
mkdir -p "$APP/data"
ENGINE_PID=""
# don't start a second engine while one is still loading (a second launch during the ~3 min warm-up)
if ! curl -s -m 2 http://127.0.0.1:8010/v1/models >/dev/null && ! pgrep -f "vllm serve" >/dev/null; then
  echo "[app] starting Nemotron engine (~3 min). log: data/engine.log"
  GPU_UTIL=${GPU_UTIL:-0.38} bash "$APP/scripts/engine.sh" > "$APP/data/engine.log" 2>&1 &
  ENGINE_PID=$!
fi
cleanup() { [ -n "$ENGINE_PID" ] && pkill -f "vllm serve"; }
trap cleanup EXIT
pkill -f "uvicorn server:app" 2>/dev/null
echo "[app] http://localhost:8020"
cd "$APP" && "$VENV/bin/python" -m uvicorn server:app --host 127.0.0.1 --port 8020 --log-level warning
