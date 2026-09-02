#!/bin/bash
# Keeps port-forwards alive with auto-restart
# Run in a separate terminal: bash start-port-forwards.sh

trap 'kill $(jobs -p) 2>/dev/null; exit' INT TERM

restart_pf() {
  local ns=$1 svc=$2 port=$3 label=$4
  while true; do
    echo "[$(date +%H:%M:%S)] Starting $label port-forward (localhost:$port)..."
    kubectl -n "$ns" port-forward "svc/$svc" "$port:5432" 2>/dev/null
    echo "[$(date +%H:%M:%S)] $label port-forward died, restarting in 2s..."
    sleep 2
  done
}

restart_pf central-auth auth-postgres-rw 5433 "Auth DB" &
restart_pf pm pm-postgres-rw 5434 "Tenant DB" &

echo "Port-forwards running. Press Ctrl+C to stop."
wait
