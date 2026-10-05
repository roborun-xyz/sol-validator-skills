#!/usr/bin/env bash
set -uo pipefail

if [ "${1:-}" = "--help" ]; then
  printf 'Usage: %s <ssh-alias> [ssh-alias...]\n' "$0"
  exit 0
fi

if [ "$#" -lt 1 ]; then
  printf 'Usage: %s <host> [host...]\n' "$0" >&2
  exit 2
fi

LOCAL_TIME_ZONE="${LOCAL_TIME_ZONE:-UTC}"

if [ ! -e "/usr/share/zoneinfo/$LOCAL_TIME_ZONE" ]; then
  printf 'error: invalid LOCAL_TIME_ZONE: %s\n' "$LOCAL_TIME_ZONE" >&2
  exit 2
fi

for host in "$@"; do
  if [[ ! "$host" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$ ]]; then
    printf 'error: invalid SSH alias\n' >&2
    exit 2
  fi
done

exit_status=0
for host in "$@"; do
  printf '===== %s =====\n' "$host"
  ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=2 -- "$host" "LOCAL_TIME_ZONE=$(printf '%q' "$LOCAL_TIME_ZONE") bash -s" <<'REMOTE' || exit_status=1
set -uo pipefail

echo "HOST=$(hostname)"
echo "UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "LOCAL=$(TZ="$LOCAL_TIME_ZONE" date +%Y-%m-%dT%H:%M:%S%z)"
echo "LOCAL_TIME_ZONE=$LOCAL_TIME_ZONE"

echo "--- service"
if systemctl list-unit-files doublezerod.service --no-pager --no-legend >/dev/null 2>&1; then
  systemctl is-active doublezerod || true
  systemctl show doublezerod \
    -p ActiveState \
    -p SubState \
    -p MainPID \
    -p NRestarts \
    -p ExecMainStartTimestamp \
    --no-pager
else
  echo "doublezerod.service=missing"
fi

echo "--- process"
ps -eo pid,comm,args | grep -E '[d]oublezerod' || true

echo "--- doublezero status"
if command -v doublezero >/dev/null 2>&1; then
  status_output="$(timeout 30s doublezero -e mainnet-beta status </dev/null 2>&1 || true)"
  printf '%s\n' "$status_output"
else
  echo "doublezero=missing"
  status_output=""
fi

echo "--- edge signal"
if printf '%s\n' "$status_output" | grep -Fq 'P:edge-solana-shreds'; then
  echo "edge_signal=present"
  printf '%s\n' "$status_output" | grep -F 'P:edge-solana-shreds' || true
else
  echo "edge_signal=missing"
fi

echo "--- interfaces"
ip -br addr show doublezero0 2>/dev/null || true
ip -br addr show doublezero1 2>/dev/null || true

echo "--- route counts"
printf 'doublezero0_routes='
ip route | grep -c ' dev doublezero0 ' || true
printf 'doublezero1_routes='
ip route | grep -c ' dev doublezero1 ' || true

echo "--- latency sample"
if command -v doublezero >/dev/null 2>&1; then
  timeout 30s doublezero -e mainnet-beta latency </dev/null 2>&1 | head -25 || true
fi

echo "--- route state sample"
if command -v doublezero >/dev/null 2>&1; then
  timeout 30s doublezero -e mainnet-beta routes </dev/null 2>&1 | head -25 || true
fi

echo "--- recent warnings"
journalctl -u doublezerod -p warning..alert -n 20 --no-pager --utc 2>/dev/null || true
REMOTE
done

exit "$exit_status"
