#!/usr/bin/env bash
# Exercise the failure scenarios from the brief against a running `docker compose up` stack.
#
#   ./scripts/chaos.sh restart     # restart the worker mid-extraction
#   ./scripts/chaos.sh flushall    # FLUSHALL Redis mid-extraction, then restart everything
#   ./scripts/chaos.sh supersede   # upload v2 while v1 is still extracting
#   ./scripts/chaos.sh all
#
# Extractions must be slow enough to interrupt. With a real LLM they usually are;
# with the fake provider start the stack with e.g. FAKE_LLM_DELAY_MS=15000.
set -euo pipefail
cd "$(dirname "$0")/.."
API=${API:-http://localhost:4000}
FIX=fixtures/documents

json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log($1)})"; }
status() { curl -s "$API/documents/$1" | json "o.status"; }
upload() { curl -s -X POST "$API/documents" -F type="$1" -F title="chaos: $2 $(date +%T)" -F file=@"$FIX/$3" | json "o.documentId"; }

wait_for() { # doc-id, regex of acceptable statuses, timeout seconds
  local t=0 s
  while :; do
    s=$(status "$1" 2>/dev/null || echo "unreachable")
    if [[ "$s" =~ ^($2)$ ]]; then echo "  -> $s after ${t}s"; return 0; fi
    if (( t >= $3 )); then echo "  !! still '$s' after ${t}s"; return 1; fi
    sleep 1; t=$((t+1))
  done
}

scenario_restart() {
  echo "== restart: worker restarted mid-extraction"
  local id; id=$(upload lease restart lease-excerpt-001.pdf)
  echo "  uploaded $id"; wait_for "$id" extracting 30
  docker compose restart worker >/dev/null
  echo "  worker restarted"; wait_for "$id" "extracted|failed" 180
  curl -s "$API/documents/$id" | json "'  attempts: ' + o.currentVersion.attempts + ', values: ' + o.values.length"
}

scenario_flushall() {
  echo "== flushall: Redis wiped mid-extraction, then the whole stack restarted"
  local id; id=$(upload market_report flushall market-report-excerpt-001.pdf)
  echo "  uploaded $id"; wait_for "$id" "extracting" 30
  docker compose exec -T redis redis-cli FLUSHALL
  docker compose restart >/dev/null
  echo "  redis flushed + stack restarted"
  until curl -sf "$API/health" >/dev/null; do sleep 1; done
  wait_for "$id" "extracted|failed" 180
  curl -s "$API/documents" | json "'  documents still present: ' + o.length + ' (none lost)'"
}

scenario_supersede() {
  echo "== supersede: v2 uploaded while v1 is extracting"
  local id; id=$(upload invoice supersede invoice-001.pdf)
  echo "  uploaded $id"; wait_for "$id" extracting 30
  curl -s -X POST "$API/documents/$id/versions" -F file=@"$FIX/invoice-001.v2.pdf" >/dev/null
  echo "  v2 uploaded"; wait_for "$id" "extracted|failed" 180
  curl -s "$API/documents/$id" | json "o.versions.map(v => '  v' + v.versionNumber + ': ' + v.status).join('\n')"
}

case "${1:-all}" in
  restart) scenario_restart ;;
  flushall) scenario_flushall ;;
  supersede) scenario_supersede ;;
  all) scenario_restart; scenario_flushall; scenario_supersede ;;
  *) echo "usage: $0 restart|flushall|supersede|all"; exit 2 ;;
esac
