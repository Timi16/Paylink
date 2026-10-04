Backend
Stack and repo structure
One TypeScript codebase in apps/api builds one Docker image that starts as either the api process or the worker process.
Stack
Concern
Choice
Runtime
Node.js 22 LTS
HTTP
Express 5
Language
TypeScript 5, strict, noUncheckedIndexedAccess
Database
PostgreSQL 16 via Prisma 6, plus pg for LISTEN/NOTIFY
Validation + OpenAPI
Zod + @asteasolutions/zod-to-openapi; Scalar served at /docs
Stellar
@stellar/stellar-sdk (rpc.Server, Horizon.Server, StrKey, Keypair, scValToNative)
Security
helmet, cors, express-rate-limit, cookie-parser, argon2
IDs
cuid for rows; CSPRNG for publicId, memos, tokens
Logging
pino + pino-http
Tests
Vitest, supertest, @testcontainers/postgresql, fast-check
Folder structure
apps/api/
  prisma/schema.prisma, migrations/
  src/
    server.ts                # api process
    worker.ts                # worker process: ingestion, reconciliation, watchdog, sweeper
    app.ts                   # buildApp(), exported for tests
    config/env.ts            # Zod-validated env; testnet passphrase enforced
    db/prisma.ts, db/notify.ts
    lib/
      amount.ts              # string <-> bigint stroops
      memo.ts                # generate + normalise Crockford memos
      ids.ts                 # publicId, API keys, session tokens
      errors.ts, logger.ts
    middleware/
      requestId.ts, auth.ts, requireOrigin.ts, rateLimit.ts,
      validate.ts, idempotency.ts, errorHandler.ts
    modules/                 # each: routes.ts, service.ts, repo.ts, schemas.ts
      auth/
      apiKeys/
      wallets/               # add, check, challenge, verify
      requests/              # create, list, cancel, accept
      transitions.ts         # transitionRequest() + allowed table
      payments/              # unmatched list, assign
      public/                # /public/pay/:publicId (+ SSE)
      stream/                # merchant SSE
      health/
    engine/
      sources/StellarSource.ts, rpcEventSource.ts, horizonBackfill.ts
      decode.ts              # event -> NormalizedPayment
      watchedWallets.ts
      matcher.ts             # decide outcome + count, inside the batch transaction
      ingestion.ts           # main loop + cursor
      reconciliation.ts, watchdog.ts, networkReset.ts
      expirySweeper.ts
    openapi/registry.ts, generate.ts
  test/unit/, integration/, helpers/
packages/shared/src/schemas/, types.ts
scripts/scenario.ts, chaos.sh, seed.ts
Layering rule
routes → service → repo. Repos that touch merchant data take merchantId first and include it in every where. Only transitions.ts may change PaymentRequest.status; a lint rule (or a code review check) forbids status: in any other Prisma update.
Express app
buildApp() wires everything in a fixed order; tests import the same function.
Middleware order
1. trust proxy 1; x-powered-by off
2. requestId (reads or generates X-Request-Id, echoes it)
3. pino-http with redaction
4. helmet
5. cors({ origin: WEB_ORIGIN, credentials: true }) for /auth and /v1; public routes allow any origin, no credentials
6. express.json({ limit: "50kb" }), cookieParser()
7. Routes:
    ◦ GET /health, GET /docs (Scalar), GET /openapi.json: public
    ◦ /public/*: 60/min per IP; SSE capped at 5 streams per IP
    ◦ /auth/*: 5/min per IP, requireOrigin
    ◦ /v1/*: requireAny (session or API key), requireOrigin on the session path, 300/min per merchant
8. 404 → NOT_FOUND; then errorHandler
Authentication
• requireAny: Authorization: Bearer pl_test_… → hash → non-revoked ApiKey → req.auth = { merchantId, via: "apiKey" }; otherwise the pl_session cookie → hash → unexpired Session → req.auth = { merchantId, via: "session" }; neither → 401.
• Wallet management (/v1/wallets/*) and API-key management are session-only.
Idempotency
POST /v1/payment-requests accepts Idempotency-Key (max 64 chars). Same key + same merchant → return the original request with 200 instead of 201. Same key with a different body → 409 IDEMPOTENCY_MISMATCH. Enforced by @@unique([merchantId, idempotencyKey]), so it holds even under concurrent retries.
Error format
{ "error": { "code": "WALLET_NOT_VERIFIED", "message": "Verify this wallet before creating requests", "details": [], "requestId": "01J…" } }
Code
HTTP
When
VALIDATION_FAILED
400
Zod failure
SECRET_KEY_REJECTED
400
An S… secret key was submitted
WALLET_NOT_VERIFIED
400
Creating a request on an unverified wallet
ACCOUNT_NOT_FOUND
400
Wallet account doesn't exist on testnet
NO_TRUSTLINE
400
Wallet can't receive the requested asset
TRUSTLINE_LIMIT_TOO_LOW
400
Amount exceeds the wallet's trustline headroom
INVALID_SIGNATURE / CHALLENGE_EXPIRED
400
Wallet verification failed
UNAUTHENTICATED
401
No or bad session / API key
FORBIDDEN_ORIGIN
403
CSRF check failed
NOT_FOUND
404
Missing or belongs to another merchant
INVALID_TRANSITION
409
e.g. cancelling a paid request
WALLET_TAKEN
409
Wallet registered by another merchant
IDEMPOTENCY_MISMATCH
409
Reused key, different body
RATE_LIMITED
429
With Retry-After
INTERNAL
500
Generic message; details only in logs
Pagination and shutdown
Lists take limit (1–100, default 50) and an opaque cursor, and return { data, nextCursor }. On SIGTERM, the API stops accepting, closes SSE streams, waits up to 10 s, and disconnects Prisma; the worker finishes its current batch transaction and exits.
Stellar engine and request matcher
Ingestion is the same design as Webhook's; what's specific to PayLink is the matcher, which turns a detected payment into exactly one outcome and, when it counts, exactly one status change.
Ingestion (same as Webhook)
• rpcEventSource.ts: getEvents with startLedger then paging cursor, limit 200; filter = Stellar Asset Contract IDs for USDC (testnet issuer) and XLM, topics transfer and mint; decode with scValToNative (topics → from, to, asset string; data → amount and optional to_muxed_id).
• to_muxed_id type → memoType: string → text, u64 → id, bytes → hash. If the day-2 spike shows a case where the memo is missing from the event, decode.ts falls back to getTransaction(txHash) and reads the envelope memo (cached per hash).
• ingestion.ts loop: load cursor → check tip (reset if tip < cursor − 100) → backfill from Horizon if the cursor is older than RPC retention → fetch → keep payments to watched wallets → one transaction: matcher.process() for each + save cursor → NOTIFY → sleep 2 s (0 s if the page was full). Errors: backoff 1 s → 30 s, cursor never advanced.
• watchedWallets.ts: every wallet where deletedAt is null, plus soft-deleted wallets that still have open requests; refreshed on NOTIFY wallets_changed and every 30 s.
• Reconciliation (2 min, last 60 ledgers), watchdog (lag > 12 ledgers for 2 min → alert; stale heartbeat → exit for Docker restart), network reset (cursor → tip, open requests → NETWORK_RESET, alert).
memo.ts
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford, no I L O U
export function generateMemo(): string; // "PL" + 8 chars from crypto.randomInt
export function normalizeMemo(raw: string): string | null {
  // trim, uppercase, O->0, I/L->1, strip spaces and dashes;
  // return null unless it matches /^PL[0-9A-HJKMNP-TV-Z]{8}$/
}
matcher.process(tx, payment)
insert ChainPayment ... ON CONFLICT (eventId) DO NOTHING; if no row -> return

if memoType == "none"                     -> outcome NO_MEMO
else if memoType != "text"                -> outcome MEMO_TYPE_MISMATCH
else memo = normalizeMemo(raw); if null   -> outcome UNKNOWN_MEMO
else req = SELECT ... FROM PaymentRequest WHERE memo = $1 FOR UPDATE
  if !req                                 -> UNKNOWN_MEMO
  link payment.requestId = req.id         (every outcome below shows on the request)
  if req.walletAddress != payment.to      -> WRONG_WALLET
  else if code != req.assetCode           -> WRONG_ASSET
  else if issuer != req.assetIssuer       -> WRONG_ISSUER
  else switch req.status:
    PAID, OVERPAID                        -> DUPLICATE
    CANCELLED                             -> AFTER_CANCEL
    NETWORK_RESET                         -> AFTER_RESET
    EXPIRED                               -> LATE
    PENDING, UNDERPAID:
      if payment.ledgerClosedAt > req.expiresAt:
        transitionRequest(req -> EXPIRED, reason "expired")
        -> LATE
      else:
        received = req.receivedStroops + amount
        to = received == req.amountStroops ? PAID
           : received <  req.amountStroops ? UNDERPAID : OVERPAID
        update receivedStroops; if PAID/OVERPAID set paidAt = ledgerClosedAt, paidTxHash
        transitionRequest(req -> to, reason "payment_counted", paymentEventId)
        -> COUNTED
save outcome on the ChainPayment row
UNDERPAID → UNDERPAID (a second partial payment) only updates receivedStroops and writes a RequestEvent; it is not a status change.
transitions.ts
const ALLOWED: Record<RequestStatus, RequestStatus[]> = {
  PENDING:       ["UNDERPAID", "PAID", "OVERPAID", "EXPIRED", "CANCELLED", "NETWORK_RESET"],
  UNDERPAID:     ["PAID", "OVERPAID", "EXPIRED", "NETWORK_RESET"],
  EXPIRED:       ["PAID"],        // merchant Accept only
  PAID:          [],
  OVERPAID:      [],
  CANCELLED:     [],
  NETWORK_RESET: [],
};

// UPDATE ... SET status = $to WHERE id = $id AND status = $expected
// 0 rows -> throw INVALID_TRANSITION; else insert RequestEvent
export async function transitionRequest(tx, id, expected, to, reason, actor, paymentEventId?) {}
Merchant actions
• Cancel: PENDING only → CANCELLED.
• Accept: from UNDERPAID or from EXPIRED when it has at least one LATE payment. Those LATE payments become COUNTED, receivedStroops is recomputed, and the request becomes PAID (actor merchant, reason accepted). The dashboard shows the amount accepted versus the amount asked.
• Assign unmatched: only for NO_MEMO, UNKNOWN_MEMO, MEMO_TYPE_MISMATCH payments, to a request on the same wallet and asset. Runs the same decision path from the status switch onward with assignedManually = true.
Expiry, live status and wallet checks
Three smaller services around the matcher: the sweeper that expires requests safely, the streams that make status changes appear instantly, and the checks that stop requests on wallets that can't receive.
Expiry sweeper (expirySweeper.ts, worker)
• Every 15 s: cutoff = min(now(), cursor.ledgerClosedAt), where ledgerClosedAt is the close time of the last fully processed ledger, saved with the cursor.
• Select up to 100 requests with status PENDING or UNDERPAID and expiresAt < cutoff; for each, in its own transaction with FOR UPDATE, call transitionRequest(… → EXPIRED, reason "expired").
• If ingestion lags, cutoff stays behind and nothing is expired early (T5).
Live status (API process)
• The API holds one pg connection that LISTENs on request_updated and payment_detected, and fans out to in-memory subscribers.
• Public GET /public/pay/:publicId/events: on connect, send the current snapshot; then push status events { status, amountReceived, amountRemaining, paidTxHash, expiresAt }; : ping every 25 s; close 5 s after a terminal status. Max 5 streams per IP.
• Merchant GET /v1/stream (session): request.updated, payment.detected (including unmatched and rejected), wallet.updated.
Wallet checks
• On add: StrKey.isValidEd25519PublicKey; refuse S… secrets; WALLET_TAKEN if another merchant has it.
• Account + trustline check: Horizon GET /accounts/{address}. 404 → accountExists = false. Otherwise cache trustlines (code, issuer, limit, balance) in Wallet.trustlines with checkedAt.
• Re-checked: on request create if checkedAt is older than 5 min, and on every checkout load (cached 30 s). Checkout data includes canReceive: boolean and a reason (ACCOUNT_NOT_FOUND, NO_TRUSTLINE, TRUSTLINE_LIMIT_TOO_LOW).
• Limit headroom: limit − balance ≥ amountRemaining, else TRUSTLINE_LIMIT_TOO_LOW.
Wallet ownership verification
1. POST /v1/wallets/:id/challenge → server stores a WalletChallenge and returns its message: PayLink wallet verification, merchant ID, a random nonce, an expiry 10 minutes out.
2. The dashboard asks Freighter to sign that message for the wallet's address.
3. POST /v1/wallets/:id/verify with the signature → server checks the challenge is unexpired and unused, verifies the signature against the address with Keypair, marks the challenge used and sets Wallet.verifiedAt.
4. Day-3 spike: sign one message with the installed Freighter version and confirm the exact signing format (SEP-53 message prefix and hashing) that verify must use; record it in a code comment with a test vector.
REST API contract
All routes return JSON with the shared error shape. "Session" = dashboard cookie; "Any" = session or API key; "Public" = no auth. Amounts go in and out as decimal strings, with stroops alongside in responses.
Auth (session)
Method + path
Body
Success
POST /auth/signup
email, password, businessName
201 { merchant } + cookie
POST /auth/login
email, password
200 { merchant } + cookie
POST /auth/logout
—
204
GET /auth/me
—
{ merchant }
POST /auth/password
currentPassword, newPassword
204; other sessions deleted
API keys (session)
GET /v1/api-keys · POST /v1/api-keys { name } → 201 { apiKey, key: "pl_test_…" } (full key shown once) · DELETE /v1/api-keys/:id → 204.
Wallets (session)
Method + path
Body
Success
GET /v1/wallets
—
{ data: Wallet[] } with verified, accountExists, trustlines, canReceive per asset
POST /v1/wallets
address, label?
201 { wallet } (unverified)
POST /v1/wallets/:id/refresh
—
{ wallet } with fresh Horizon data
POST /v1/wallets/:id/challenge
—
{ challengeId, message, expiresAt }
POST /v1/wallets/:id/verify
challengeId, signature
{ wallet } with verifiedAt
DELETE /v1/wallets/:id
—
204 (soft; watched until its open requests close)
Payment requests (any)
Method + path
Body / query
Success
POST /v1/payment-requests
walletId, amount, asset ("USDC" or "XLM"), expiresInMinutes? (5–43,200, default 30), description?, customerRef?, metadata?; header Idempotency-Key?
201 { request, checkoutUrl }
GET /v1/payment-requests
status, walletId, from, to, q (memo or customerRef), cursor, limit
{ data, nextCursor }
GET /v1/payment-requests/:id
—
Request + all linked payments (every outcome) + audit trail
POST /v1/payment-requests/:id/cancel
—
{ request }; 409 unless PENDING
POST /v1/payment-requests/:id/accept
—
{ request }; 409 unless UNDERPAID, or EXPIRED with a LATE payment
Example response:
{
  "request": {
    "id": "clx…",
    "publicId": "aZ81kQp0LmX3",
    "status": "PENDING",
    "wallet": "GABC…",
    "asset": { "code": "USDC", "issuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    "amount": "50.0000000",
    "amountStroops": "500000000",
    "amountReceived": "0.0000000",
    "memo": "PL7K2M9QXA",
    "expiresAt": "2026-10-07T10:30:00Z",
    "paidTxHash": null,
    "description": "Order #1042"
  },
  "checkoutUrl": "https://paylink.<domain>/pay/aZ81kQp0LmX3"
}
Payments (any)
Method + path
Query / body
Success
GET /v1/payments
walletId, outcome, unmatched=true, cursor, limit
{ data: ChainPayment[], nextCursor }
POST /v1/payments/:eventId/assign
requestId
{ payment, request }; 409 if not an unmatched outcome, or wallet/asset differ
Public (checkout)
Method + path
Success
GET /public/pay/:publicId
{ businessName, amount, amountReceived, amountRemaining, asset, wallet, memo, description, status, expiresAt, paidTxHash, canReceive, cannotReceiveReason, sep7Uri }
GET /public/pay/:publicId/events
SSE status stream
Other
GET /v1/stream (session SSE) · GET /health · GET /openapi.json · GET /docs (Scalar).
Config, env vars and scripts
config/env.ts validates everything at startup and stops the process with a clear message on any problem.
Environment variables
Variable
Example
Used by
Rule
NODE_ENV
production
both

PORT
4100
api

DATABASE_URL
postgresql://paylink:…@postgres:5432/paylink
both

STELLAR_RPC_URL
https://soroban-testnet.stellar.org
worker

HORIZON_URL
https://horizon-testnet.stellar.org
both
Backfill + wallet checks
NETWORK_PASSPHRASE
Test SDF Network ; September 2015
both
Must be the testnet passphrase
USDC_ISSUER
GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
both
Valid G address
WEB_ORIGIN
https://paylink.<domain>
api
CORS, CSRF, checkout URLs
SESSION_SECRET
64 hex chars
api
≥ 32 bytes
ALERT_TELEGRAM_BOT_TOKEN, ALERT_TELEGRAM_CHAT_ID

worker
Optional
LOG_LEVEL
info
both

.env.example must list every variable; CI checks it against env.ts.
npm scripts (apps/api)
dev, dev:worker, build, start, start:worker, lint, typecheck, test, db:migrate, db:deploy, openapi: run the API / worker with reload, compile, start compiled builds, lint, type-check, run tests, create or apply migrations, and write `openapi.json`.
Repo scripts
Script
Does
scenario.ts
Creates Friendbot accounts (merchant, payer, fake issuer), trustlines, a verified wallet and a merchant via the API, then runs every P and T case on testnet and asserts the final request status + payment outcome. Doubles as the demo.
chaos.sh
Kills the worker mid-burst, points RPC at a dead host, stops Postgres for 60 s; then checks counts and statuses
seed.ts
Demo merchant, wallet and a spread of requests in every status for local UI work
Testing plan
Every case below has an ID; each gets at least one test whose name starts with it (it("P12: payment after PAID is DUPLICATE", …)), so coverage is checkable with grep. Unit tests cover memo, amount, decode, the matcher decision table and transitions; integration tests run against a real Postgres (Testcontainers) with a fake StellarSource; the scenario script proves the P and T cases on real testnet.
Matching
ID
Case
Expected outcome → request status
P1
Right wallet, asset, issuer, amount, memo, before expiry
COUNTED → PAID, tx hash stored
P2
No memo
NO_MEMO, unmatched list
P3
Memo not linked to any request
UNKNOWN_MEMO, unmatched list
P4
Memo lowercase, O for 0, spaces or dashes
Normalised → COUNTED
P5
MEMO_ID or MEMO_HASH
MEMO_TYPE_MISMATCH, unmatched list
P6
Right memo, wrong asset (XLM for a USDC request)
WRONG_ASSET; request unchanged
P7
Right memo, "USDC" from another issuer
WRONG_ISSUER; request unchanged
P8
Memo of a request on a different wallet
WRONG_WALLET; request unchanged
P9
Amount below asked
COUNTED → UNDERPAID, remaining amount exposed
P10
Partials summing exactly
Last one COUNTED → PAID
P11
Above asked, or partials overshoot
COUNTED → OVERPAID
P12
Any payment after PAID/OVERPAID
DUPLICATE; status unchanged
P13
Two payment ops to one request in one tx
Two events, both COUNTED, summed
P14
Path payment (payer sends XLM, wallet gets USDC)
Counted by USDC received
P15
Payer is a contract wallet (C address)
Detected and matched normally
P16
Paid to the wallet's M-address
Base wallet resolved; mux ID present → MEMO_TYPE_MISMATCH, assignable
P17
Payment from the asset issuer (mint)
Matched normally
P18
Off by one stroop
UNDERPAID or OVERPAID, never rounded
P19
Failed transaction
No event, nothing recorded
P20
Fee-bump transaction
Outer and inner hashes stored
P21
Funds via claimable balance claim
No memo → NO_MEMO, assignable
Timing
ID
Case
Expected
T1
Ledger before expiry, ingested after
COUNTED → PAID
T2
Ledger after expiry
LATE, request EXPIRED; Accept → PAID
T3
Partial, then expiry
EXPIRED with amountReceived shown, refund flag
T4
Payment after cancel
AFTER_CANCEL
T5
Ingestion 3 min behind at expiry
Not expired until the processed ledger passes expiresAt
T6
Server clock skew
Ledger time decides; chrony on the server
T7
Expiry outside 5 min–30 days
400 VALIDATION_FAILED
Merchant setup
ID
Case
Expected
M1
Invalid address, M-address, or S… secret pasted
400; secret never stored or logged
M2
Account doesn't exist
Request creation → ACCOUNT_NOT_FOUND
M3
No USDC trustline
NO_TRUSTLINE; checkout canReceive: false
M4
Trustline limit too low
TRUSTLINE_LIMIT_TOO_LOW
M5
Wallet removed with open requests
Soft-deleted, still watched; requests keep their snapshot
M6
Wallet already owned by another merchant
409 WALLET_TAKEN
M7
Same Idempotency-Key twice / with a different body
Same request (200) / 409
M8
Amount 0, negative, > 7 decimals, too large
400
M9
Unsupported asset
400 with allowed list
Checkout (API side; UI side in the Frontend tab)
ID
Case
Expected
C1
Unknown publicId
404
C5
Reload after paying
Snapshot returns current status
C6
SSE dropped and reconnected
Snapshot on reconnect, no missed final status
C8
Two payments land together
Row lock → exact sum, one status change
System
ID
Case
Expected
S1
Worker killed mid-batch
Batch rolls back and replays; counts exact
S2
RPC down or rate-limited
Backoff, lag alert, full catch-up, nothing expired early
S3
Postgres down
API 503; worker pauses without advancing the cursor
S4
Server reboot
Containers restart, worker resumes from cursor
S5
Testnet reset
Open requests → NETWORK_RESET, later payments AFTER_RESET, alert
Tenant isolation: one test per /v1 route proves merchant A gets 404 for merchant B's IDs.