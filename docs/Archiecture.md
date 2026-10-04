Architecture
System overview
PayLink is two processes from one codebase (paylink-api and paylink-worker) sharing one PostgreSQL database, plus one Next.js app on Vercel for both the dashboard and the checkout. The worker is the only part that decides whether a request is paid.
The checkout never talks to Stellar's event stream: it reads status from the API, which hears about changes from Postgres NOTIFY. That keeps one source of truth for "Paid".
Request-to-paid lifecycle
From ledger close to "Paid" on the customer's screen takes about 5–10 s and one database transaction. If the process dies at any point, the work is either fully committed or fully redone.
1. Merchant creates a request. The API validates the input, snapshots the wallet address and asset, generates a memo with a CSPRNG (retrying on the rare unique-constraint collision), and stores the request as PENDING.
2. Customer opens the checkout (/pay/{publicId}), loads the public request data and subscribes to its live status stream.
3. Customer pays; the ledger closes about 5 s later.
4. Worker polls getEvents every 2 s from the saved cursor (allowed-asset contract IDs, topics transfer and mint), decodes each event into a NormalizedPayment, and keeps only those whose destination is a watched wallet. Every active wallet is watched at all times, so late and duplicate payments are caught too.
5. One transaction:
    1. INSERT ChainPayment … ON CONFLICT (eventId) DO NOTHING; if it already existed, stop.
    2. Normalise the memo and look up PaymentRequest by memo with SELECT … FOR UPDATE.
    3. Decide the outcome (table in the state-machine section): counted, duplicate, late, after-cancel, wrong asset/issuer/wallet, or unmatched.
    4. If counted: add the amount to receivedStroops and call transitionRequest() (→ PAID, UNDERPAID or OVERPAID), writing a RequestEvent audit row.
    5. Save the outcome on the ChainPayment row and advance the cursor.
    6. COMMIT, then NOTIFY request_updated with the request's public ID and merchant ID.
6. API fans out the change over Server-Sent Events to the checkout page for that request and to the merchant's dashboard.
7. Expiry sweeper (every 15 s) moves open requests to EXPIRED only once both the clock and the last processed ledger's close time are past expiresAt.
What protects each step
Failure
Protection
Same event seen twice (reconciliation, restart)
ChainPayment.eventId primary key
Two payments for one request processed at once
SELECT … FOR UPDATE on the request row
Status jumping somewhere invalid
transitionRequest() checks the allowed-transitions table and does a conditional update on the expected current status
Crash between match and cursor update
Same transaction: both or neither
Payment just before expiry, ingested after
Ledger-time expiry rule; sweeper waits for ingestion to pass expiresAt
Merchant edits wallet while a request is open
Request keeps its snapshot of wallet and asset
Memo collision
@@unique([memo]) across all requests, retried on conflict
Key design decisions
Final for v1; Claude Code should not swap any of these without asking.
Decision
Why
Trade-off accepted
Memo (MEMO_TEXT) as the payment reference
Free, standard, every wallet supports it; no per-payment accounts or reserves
Customers can forget it → Unmatched list + manual assign
Memo unique across all of PayLink, forever
A memo maps to exactly one request; lets us detect "right memo, wrong wallet"
Slightly larger collision space to manage (retry on conflict)
Crockford base32 memo, normalised on match
Forgiving of typed memos (case, O/0, I/1)
None
Partial payments add up until expiry
Customers often split or short-pay by fees; matches real shop behaviour
Merchant must refund overpayments themselves
Request snapshots wallet + asset at creation
Later edits can never change what an open request expects
Old requests still point at a removed wallet (kept watched until closed)
Ledger close time decides expiry
Lag or server clock can't wrongly expire a paid request
Expiry can be a few seconds late while ingestion catches up
One transitionRequest() with a row lock
All status rules in one place; concurrent payments can't race
None
Stellar RPC getEvents as the live source
One event shape (CAP-67) for payments, path payments, contract wallets
Short RPC history → Horizon kept for backfill
No Redis; Postgres LISTEN/NOTIFY for live updates
One less service on a 2 GB server
Single API instance (fine at testnet scale)
One Next.js app for dashboard + checkout
Shared components and tokens; one deploy
Checkout bundle must stay lean (no dashboard code on /pay)
Public SSE stream per request
Customer sees Paid instantly without an account
Stream exposes status only, rate-limited per IP
Wallet ownership proven with a Freighter-signed challenge
Stops anyone pointing requests at someone else's wallet
Merchants need Freighter (or another SEP-53 wallet) once per wallet
Data model
The full Prisma schema for v1. The unique constraints and the snapshot fields on PaymentRequest are part of the design: they are what makes double-counting and moving targets impossible.
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Merchant {
  id           String           @id @default(cuid())
  email        String           @unique
  passwordHash String
  businessName String
  createdAt    DateTime         @default(now())
  sessions     Session[]
  apiKeys      ApiKey[]
  wallets      Wallet[]
  requests     PaymentRequest[]
  challenges   WalletChallenge[]
}

model Session {
  id         String   @id // sha256 of the cookie token
  merchantId String
  merchant   Merchant @relation(fields: [merchantId], references: [id], onDelete: Cascade)
  expiresAt  DateTime
  createdAt  DateTime @default(now())
  ip         String?
  userAgent  String?

  @@index([merchantId])
}

model ApiKey {
  id         String    @id @default(cuid())
  merchantId String
  merchant   Merchant  @relation(fields: [merchantId], references: [id], onDelete: Cascade)
  name       String
  prefix     String    // e.g. "pl_test_9f2a"
  keyHash    String    @unique
  lastUsedAt DateTime?
  revokedAt  DateTime?
  createdAt  DateTime  @default(now())

  @@index([merchantId])
}

model Wallet {
  id                String           @id @default(cuid())
  merchantId        String
  merchant          Merchant         @relation(fields: [merchantId], references: [id])
  address           String           @unique // base G address; one merchant per wallet
  label             String?
  verifiedAt        DateTime?        // set after a valid signed challenge
  accountExists     Boolean          @default(false)
  trustlines        Json             @default("[]") // [{ code, issuer, limit }] cached from Horizon
  checkedAt         DateTime?
  deletedAt         DateTime?        // soft delete; still watched while it has open requests
  createdAt         DateTime         @default(now())
  requests          PaymentRequest[]
  payments          ChainPayment[]
}

model WalletChallenge {
  id         String    @id @default(cuid())
  merchantId String
  merchant   Merchant  @relation(fields: [merchantId], references: [id], onDelete: Cascade)
  address    String
  message    String    // "PayLink wallet verification\nMerchant: …\nNonce: …\nExpires: …"
  expiresAt  DateTime  // 10 minutes
  usedAt     DateTime?
  createdAt  DateTime  @default(now())

  @@index([merchantId, address])
}

enum RequestStatus {
  PENDING
  UNDERPAID
  PAID
  OVERPAID
  EXPIRED
  CANCELLED
  NETWORK_RESET
}

model PaymentRequest {
  id              String         @id @default(cuid())
  publicId        String         @unique // 12 random base62 chars, used in /pay/{publicId}
  merchantId      String
  merchant        Merchant       @relation(fields: [merchantId], references: [id])
  walletId        String
  wallet          Wallet         @relation(fields: [walletId], references: [id])
  walletAddress   String         // snapshot
  assetCode       String         // snapshot
  assetIssuer     String?        // snapshot; null = XLM
  amountStroops   BigInt
  receivedStroops BigInt         @default(0)
  memo            String         @unique // "PL" + 8 Crockford base32, stored uppercase
  status          RequestStatus  @default(PENDING)
  description     String?
  customerRef     String?        // merchant's own order ID
  metadata        Json?
  expiresAt       DateTime
  paidAt          DateTime?
  paidTxHash      String?        // tx that completed the payment
  cancelledAt     DateTime?
  idempotencyKey  String?
  idempotencyHash String?        // sha256 of the create body, to detect key reuse with a different body
  createdVia      String         // "dashboard" | "api"
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt
  payments        ChainPayment[]
  events          RequestEvent[]

  @@unique([merchantId, idempotencyKey])
  @@index([merchantId, createdAt])
  @@index([status, expiresAt])
}

enum PaymentOutcome {
  COUNTED            // applied to the request's received amount
  DUPLICATE          // request already PAID or OVERPAID
  LATE               // ledger time after expiresAt
  AFTER_CANCEL
  WRONG_ASSET
  WRONG_ISSUER       // same code, different issuer (counterfeit)
  WRONG_WALLET       // memo belongs to a request on another wallet
  NO_MEMO
  UNKNOWN_MEMO
  MEMO_TYPE_MISMATCH
  AFTER_RESET
}

model ChainPayment {
  eventId        String          @id // RPC event id
  txHash         String
  innerTxHash    String?
  ledger         Int
  ledgerClosedAt DateTime
  walletId       String
  wallet         Wallet          @relation(fields: [walletId], references: [id])
  fromAddress    String
  toAddress      String          // base G
  toMuxedId      String?
  memoRaw        String?
  memoNormalized String?
  memoType       String          // "none" | "text" | "id" | "hash"
  assetCode      String
  assetIssuer    String?
  amountStroops  BigInt
  eventType      String          // "transfer" | "mint"
  source         String          // "rpc" | "horizon"
  requestId      String?
  request        PaymentRequest? @relation(fields: [requestId], references: [id])
  outcome        PaymentOutcome
  assignedManually Boolean       @default(false)
  assignedAt     DateTime?
  createdAt      DateTime        @default(now())

  @@index([walletId, createdAt])
  @@index([requestId])
  @@index([outcome])
  @@index([txHash])
}

model RequestEvent {
  id             String         @id @default(cuid())
  requestId      String
  request        PaymentRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  fromStatus     RequestStatus
  toStatus       RequestStatus
  reason         String         // "payment_counted" | "expired" | "cancelled" | "accepted" | "network_reset"
  actor          String         // "system" | "merchant" | "api"
  paymentEventId String?
  createdAt      DateTime       @default(now())

  @@index([requestId, createdAt])
}

model Cursor {
  name               String    @id // "rpc-events"
  ledger             Int
  pagingToken        String?
  ledgerClosedAt     DateTime? // close time of the last fully processed ledger (used by the expiry sweeper)
  networkPassphrase  String
  lastNetworkResetAt DateTime?
  updatedAt          DateTime  @updatedAt
}
Notes:
• Payments that reach a watched wallet but match no request keep requestId = null; these form the merchant's Unmatched payments list. Manual assign sets requestId, assignedManually, and runs the normal counting path.
• RequestEvent is append-only; nothing updates or deletes it.
• Amount fields are BigInt; Prisma returns bigint, and the API serialises them as decimal strings.
Request states and payment outcomes
A request moves only through transitionRequest() and the allowed table in the Backend tab; the drawing shows the main paths.
Not drawn, but allowed: PENDING straight to OVERPAID (one payment for more than asked); the merchant's Accept moving UNDERPAID, or EXPIRED with late payments, to PAID; and PENDING/UNDERPAID to NETWORK_RESET when testnet is wiped. PAID, OVERPAID, CANCELLED and NETWORK_RESET are final.
Payment outcomes
Every detected payment to a watched wallet gets exactly one outcome; only COUNTED changes a request's received amount.
Outcome
Meaning
Shown to merchant as
COUNTED
Applied to the request
Paid / part-payment
DUPLICATE
Request was already Paid or Overpaid
Refund owed
LATE
Ledger time after expiry
Refund owed, or Accept
AFTER_CANCEL
Request was cancelled
Refund owed
AFTER_RESET
Request was closed by a testnet reset
Refund owed
WRONG_ASSET
Right memo, different asset
Rejected, refund owed
WRONG_ISSUER
Same code, different issuer (counterfeit)
Rejected, flagged red
WRONG_WALLET
Memo belongs to a request on another wallet
Rejected, refund owed
NO_MEMO, UNKNOWN_MEMO, MEMO_TYPE_MISMATCH
Can't be tied to a request automatically
Unmatched: assign or refund
Security architecture
PayLink never holds a Stellar secret key or moves funds. The real risks are a merchant seeing another merchant's data, someone pointing requests at a wallet they don't own, and a public checkout page being abused or faked; each has a control below.
Checklist
Accounts and access
[ ] Passwords: argon2id, minimum 10 characters
[ ] Sessions: 32-byte random token in an httpOnly, Secure, SameSite=Lax cookie; only its SHA-256 stored; 14-day expiry; rotated on login
[ ] CSRF: cookie-authenticated POST/PATCH/DELETE must carry an Origin equal to WEB_ORIGIN
[ ] Login rate limit 5/min per IP plus growing per-account delay; same error for wrong email or password
[ ] API keys: pl_test_ + 32 random bytes (base62), shown once, SHA-256 stored, revocable
[ ] Tenant isolation: every repo function on merchant data requires merchantId; tests prove cross-merchant access returns 404
Wallets
[ ] One wallet, one merchant (Wallet.address @unique); an unverified claim never blocks the real owner
[ ] Requests can only be created on a verified wallet: the merchant signs a server-issued challenge (10-minute expiry, single use) with Freighter's message signing; the API verifies the signature against the address
[ ] Pasted S… secret keys are refused, never stored or logged
Public checkout
[ ] publicId is 12 random base62 characters (not guessable, not sequential)
[ ] Public endpoints return only: merchant business name, amount, asset, wallet, memo, description, status, expiry, paid tx hash
[ ] Rate limits: 60/min per IP on public GETs; max 5 open SSE streams per IP
[ ] Permanent "Stellar Testnet · no real money" banner; merchant name and wallet shown so payers can spot a fake
[ ] frame-ancestors 'none' on the checkout so it can't be embedded in a look-alike page
Input and output
[ ] Zod .strict() on every body, query and param
[ ] Amounts: regex ^\d{1,12}(\.\d{1,7})?$, converted to bigint stroops, must be > 0
[ ] Description and customerRef length-limited (200 / 64) and rendered as plain text
HTTP hardening (Express)
[ ] helmet (HSTS, noSniff, strict referrer policy), cors allowlist = web origin, credentials: true
[ ] express.json({ limit: "50kb" }), x-powered-by off, trust proxy 1
[ ] Rate limits: 300/min per merchant on /v1, 5/min on auth
Logs, secrets, dependencies, server
[ ] pino redact for authorization, cookie, password and key fields
[ ] .env never committed; .env.example current
[ ] Lockfile committed, pnpm audit in CI, Dependabot on
[ ] Server: UFW 22/80/443, SSH keys only, fail2ban, unattended-upgrades; Postgres listening on localhost only
Infrastructure and deployment
PayLink's backend runs as two pm2 processes on the InterServer slice it shares with Webhook (1 core, 2 GB RAM, 40 GB SSD); the web app runs on Vercel's free tier.
Processes (PayLink's share)
Process
Memory limit
Runs
paylink-api
256 MB (max_memory_restart)
Express API + SSE (node --max-old-space-size=192), one instance, fork mode
paylink-worker
256 MB (max_memory_restart)
Ingestion, reconciliation, watchdog, expiry sweeper
postgres (shared)
384 MB
Separate paylink database and DB user
caddy (shared)
64 MB
HTTPS + reverse proxy to 127.0.0.1:4100
Both processes are defined in ecosystem.config.cjs: autorestart with backoff, pm2 startup + pm2 save so they survive a reboot, pm2-logrotate for logs. The API must stay a single instance (live updates and the login throttle are in memory). 2 GB swap as the safety net.
Domains
Address
Serves
paylink.<domain>
Dashboard + checkout (/pay/{publicId}) on Vercel
api.paylink.<domain>
Caddy → paylink-api (also serves the API reference at /docs)
Both must share the same registrable domain so the session cookie (SameSite=Lax) is sent.
Deploy pipeline
1. Push to main → GitHub Actions: install, lint, typecheck, test (Postgres service container).
2. SSH with a deploy-only key and run deploy/deploy.sh <sha> on the server.
3. The script checks out the commit, installs with the frozen lockfile, runs prisma migrate deploy, builds, then pm2 reload.
4. It polls /health for 60 s; on failure it rebuilds the previous commit, reloads and fails the job.
5. Vercel deploys apps/web from the same push.
Migrations stay additive during the build so a rollback never meets a schema it can't read.
Monitoring and backups
• /health: DB status, last processed ledger, lag in seconds, open request count. UptimeRobot every 5 min.
• Telegram alerts: lag > 60 s for 2 min, testnet reset detected, worker heartbeat stale, backup failed.
• Nightly pg_dump paylink → gzip → encrypt → off-server; keep 7 days; one restore tested before handover.