#!/bin/sh
set -eu

CONFIG_PATH="${CONFIG_PATH:-/app/config/config.yaml}"
CONFIG_TEMPLATE="/app/config-defaults/config.example.yaml"

mkdir -p "$(dirname "$CONFIG_PATH")" /app/data /app/recordings /app/biliup

if [ ! -f "$CONFIG_PATH" ] && [ -f "$CONFIG_TEMPLATE" ]; then
  cp "$CONFIG_TEMPLATE" "$CONFIG_PATH"
  echo "Initialized configuration at $CONFIG_PATH"
fi

# DDTalks is outside the MVP. A virtual display is opt-in and its failure must
# not stop public live playback or the private recording/upload control plane.
if [ "${ENABLE_XVFB:-0}" = "1" ]; then
  display_number="${DISPLAY:-:99}"
  Xvfb "$display_number" -screen 0 1920x1080x24 -ac +extension RANDR &
  xvfb_pid=$!
  xvfb_ready=0
  attempt=0

  while [ "$attempt" -lt 20 ]; do
    if xdpyinfo -display "$display_number" >/dev/null 2>&1; then
      xvfb_ready=1
      break
    fi
    attempt=$((attempt + 1))
    sleep 0.1
  done

  if [ "$xvfb_ready" = "1" ]; then
    echo "Xvfb is ready on $display_number"
  else
    echo "WARNING: Xvfb failed to become ready; continuing without DDTalks support" >&2
    kill "$xvfb_pid" 2>/dev/null || true
  fi
else
  echo "Xvfb disabled (set ENABLE_XVFB=1 only when DDTalks support is needed)"
fi

# tini forwards termination signals and reaps recorder/uploader subprocesses.
exec /usr/bin/tini -g -- node index.js
