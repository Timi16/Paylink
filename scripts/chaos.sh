#!/usr/bin/env bash
# Chaos checks against the pm2-managed stack (ecosystem.config.cjs), run on the server.
#   1. kill the worker mid-burst      -> no payment missed or double-counted
#   2. point RPC at a dead host       -> backoff, nothing expired early, full catch-up
#   3. stop Postgres for 60 s         -> API 503, worker pauses, both recover
# Usage: DATABASE_URL=postgresql://… ./scripts/chaos.sh
# Needs psql, pm2 and the right to stop Postgres (PG_STOP / PG_START override the commands).
set -euo pipefail

API_URL="${API_URL:-http://localhost:4100}"
: "${DATABASE_URL:?set DATABASE_URL}"
PG_STOP="${PG_STOP:-sudo systemctl stop postgresql}"
PG_START="${PG_START:-sudo systemctl start postgresql}"
WORKER=paylink-worker

sql() { psql "${DATABASE_URL%%\?*}" -Atc "$1"; }
health() { curl -s -o /dev/null -w '%{http_code}' "$API_URL/health"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
wait_for() { # wait_for <seconds> <command…>
  local deadline=$((SECONDS + $1)); shift
  until "$@"; do [ $SECONDS -lt $deadline ] || return 1; sleep 3; done
}
caught_up() { [ "$(curl -s "$API_URL/health" | sed -n 's/.*"lagSeconds":\([0-9]*\).*/\1/p')" -lt 30 ] 2>/dev/null; }
invariants() {
  # Every request's received amount must equal the sum of its COUNTED payments,
  # and its status must agree with that amount.
  local bad
  bad=$(sql "SELECT count(*) FROM \"PaymentRequest\" r WHERE r.\"receivedStroops\" <> COALESCE((SELECT sum(p.\"amountStroops\") FROM \"ChainPayment\" p WHERE p.\"requestId\" = r.id AND p.outcome = 'COUNTED'), 0)")
  [ "$bad" = "0" ] || fail "$bad request(s) whose received amount is not the sum of COUNTED payments"
  bad=$(sql "SELECT count(*) FROM \"PaymentRequest\" WHERE (status = 'PAID' AND \"paidTxHash\" IS NULL) OR (status = 'PENDING' AND \"receivedStroops\" <> 0) OR (status = 'OVERPAID' AND \"receivedStroops\" <= \"amountStroops\") OR (status = 'UNDERPAID' AND \"receivedStroops\" >= \"amountStroops\")")
  [ "$bad" = "0" ] || fail "$bad request(s) with a status that contradicts the amounts"
  echo "  invariants hold"
}

echo "== 1. kill the worker mid-burst =="
echo "  start a burst now in another terminal:  pnpm scenario -- --skip-timing"
sleep "${BURST_DELAY:-20}"
before=$(sql 'SELECT count(*) FROM "ChainPayment"')
kill -9 "$(pm2 pid $WORKER)"   # pm2 restarts it by itself
sleep 15
wait_for 180 caught_up || fail "worker did not catch up after kill -9"
after=$(sql 'SELECT count(*) FROM "ChainPayment"')
dupes=$(sql 'SELECT count(*) FROM (SELECT "txHash", "toAddress", "amountStroops", count(*) FROM "ChainPayment" GROUP BY 1,2,3, "eventId" HAVING count(*) > 1) d')
[ "$dupes" = "0" ] || fail "duplicate event rows after restart"
echo "  payments before kill: $before, after catch-up: $after"
invariants

echo "== 2. RPC unreachable =="
open_before=$(sql "SELECT count(*) FROM \"PaymentRequest\" WHERE status IN ('PENDING','UNDERPAID')")
# Variables already in the environment win over --env-file, so this overrides .env.
STELLAR_RPC_URL=http://10.255.255.1:1 pm2 restart $WORKER --update-env
sleep 90
expired=$(sql "SELECT count(*) FROM \"RequestEvent\" WHERE reason = 'expired' AND \"createdAt\" > now() - interval '80 seconds'")
[ "$expired" = "0" ] || fail "$expired request(s) expired while ingestion was blind"
pm2 delete $WORKER && pm2 start ecosystem.config.cjs --only $WORKER   # back to the .env value
wait_for 300 caught_up || fail "worker did not catch up after the RPC outage"
echo "  open requests before: $open_before; none expired early"
invariants

echo "== 3. Postgres down for 60 s =="
cursor_before=$(sql 'SELECT ledger FROM "Cursor" LIMIT 1')
$PG_STOP
sleep 10
[ "$(health)" = "503" ] || fail "API did not answer 503 with Postgres down (got $(health))"
sleep 50
$PG_START
api_up() { [ "$(health)" = "200" ]; }
wait_for 120 api_up || fail "API did not recover"
wait_for 300 caught_up || fail "worker did not resume after Postgres came back"
cursor_after=$(sql 'SELECT ledger FROM "Cursor" LIMIT 1')
[ "$cursor_after" -ge "$cursor_before" ] || fail "cursor moved backwards"
echo "  cursor $cursor_before -> $cursor_after"
invariants

echo "ALL CHAOS CHECKS PASSED"
