#!/bin/sh
set -eu

steel_pid=''
studio_pid=''
stopping=0

shutdown() {
  [ "$stopping" -eq 0 ] || return 0
  stopping=1
  trap - TERM INT EXIT
  [ -z "$studio_pid" ] || kill -TERM "$studio_pid" 2>/dev/null || true
  [ -z "$steel_pid" ] || kill -TERM "$steel_pid" 2>/dev/null || true
  (
    sleep 18
    [ -z "$studio_pid" ] || kill -KILL "$studio_pid" 2>/dev/null || true
    [ -z "$steel_pid" ] || kill -KILL "$steel_pid" 2>/dev/null || true
  ) &
  shutdown_deadline=$!
  [ -z "$studio_pid" ] || wait "$studio_pid" 2>/dev/null || true
  [ -z "$steel_pid" ] || wait "$steel_pid" 2>/dev/null || true
  kill "$shutdown_deadline" 2>/dev/null || true
  wait "$shutdown_deadline" 2>/dev/null || true
}
trap shutdown TERM INT EXIT

export HERMES_STEEL_BROWSER_URL=http://127.0.0.1:3000
export NODE_ENV=production
export DISPLAY=:10

HOST=127.0.0.1 PORT=3000 DOMAIN=127.0.0.1:3000 CDP_DOMAIN=127.0.0.1:3000 CDP_REDIRECT_PORT=9223 \
  /opt/steel-node/node /opt/steel/api/build/index.js &
steel_pid=$!

ready=0
attempt=0
while [ "$attempt" -lt 60 ]; do
  if ! kill -0 "$steel_pid" 2>/dev/null; then
    echo 'Steel Browser exited before readiness' >&2
    exit 1
  fi
  if curl -fsS --max-time 2 http://127.0.0.1:3000/v1/health >/dev/null 2>&1; then
    ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo 'Steel Browser readiness timeout' >&2
  exit 1
fi

export PORT="${HERMES_STUDIO_PORT:-6060}"
node dist/server/index.js &
studio_pid=$!

monitor_child() {
  while kill -0 "$studio_pid" 2>/dev/null && kill -0 "$steel_pid" 2>/dev/null; do
    sleep 1
  done
  if ! kill -0 "$studio_pid" 2>/dev/null; then
    wait "$studio_pid"
    return $?
  fi
  wait "$steel_pid"
  return $?
}

set +e
monitor_child
status=$?
set -e
shutdown
exit "$status"
