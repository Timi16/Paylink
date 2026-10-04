PayLink — Build Plan & Architecture
4 Oct 2026 · @Timmy
How to use this with Claude Code
This doc is the full spec for PayLink, the Stellar Testnet payment request and verification app: this Build Plan tab plus Architecture, Backend and Frontend. Export each tab to Markdown and commit it to the repo so Claude Code reads it every session.
Repo setup
File in repo
Comes from
docs/BUILD_PLAN.md
This tab
docs/ARCHITECTURE.md
Architecture tab
docs/BACKEND.md
Backend tab
docs/FRONTEND.md
Frontend tab
CLAUDE.md (repo root)
The working rules below, plus: "Read everything in /docs before starting any task."
First message to Claude Code: "Read CLAUDE.md and everything in /docs. Ask me any questions you have, then start Phase 0 of BUILD_PLAN.md. Stop at the end of each phase and show me the gate check results."
Working rules for Claude Code (paste into CLAUDE.md)
1. Follow the docs. If something is unclear or seems wrong, ask before building. If we agree on a change, update the matching doc in the same commit.
2. One phase at a time, in order. A phase is done only when its gate check passes.
3. TypeScript strict everywhere; no any, no unexplained @ts-ignore.
4. Money is never a float: bigint stroops in code, BigInt columns in Postgres, decimal strings in JSON. parseFloat and Number() on amounts are banned.
5. A payment request's status changes in exactly one function (transitionRequest), which checks the allowed-transitions table and runs inside a transaction holding a row lock on the request.
6. Expiry is judged by ledger close time, never by server clock alone.
7. A memo is never reused anywhere in PayLink, even after its request expires.
8. Every edge-case ID in these docs (P1–P21, T1–T7, M1–M9, C1–C8, S1–S5) gets at least one test whose name starts with that ID.
9. Never log secrets: passwords, API keys, session tokens, full Authorization headers. Never store or log a Stellar secret key, even if a user pastes one.
10. Testnet only: refuse to boot unless the network passphrase is the testnet one.
11. Before saying a task is done, run npm run lint, typecheck and test, and report the results.
12. Small commits with conventional messages (feat:, fix:, test:, docs:).
Scope and end result
A business creates a payment request (say 50 USDC); PayLink gives it a unique ID, memo and checkout link; the customer pays on Stellar Testnet; PayLink detects the payment, verifies it, and flips the request from Pending to Paid with the transaction hash. Wrong, partial, duplicate, late and expired payments are all recognised and shown, never silently ignored.
End-to-end flow
1. Merchant signs up, adds and verifies their testnet wallet.
2. Merchant creates a request: amount, asset, description, expiry. PayLink returns a checkout link and memo.
3. Customer opens /pay/{publicId}: amount, wallet, memo, QR code, countdown, "Pay with Freighter".
4. Customer pays; the worker detects it from Stellar RPC within seconds of the ledger closing.
5. The matcher finds the request by memo and verifies wallet, asset + issuer, amount and ledger time against expiry.
6. The request becomes paid (or underpaid / overpaid); the checkout page updates live and shows the tx hash linked to stellar.expert; the merchant's dashboard updates too.
Deliverables
#
Deliverable
Phases
1
Payment requests + verification engine: create, detect, verify, status, edge cases
0, 1, 2
2
Checkout page: how and where to pay, live status, tx hash
3
3
Merchant dashboard + API reference
4
—
Hardening, deployment and handover
5
Decisions already made
• Backend: Node.js + Express 5 + TypeScript, Prisma, PostgreSQL. No Redis (single API instance; Postgres LISTEN/NOTIFY for live updates).
• Frontend: one Next.js app for both the merchant dashboard and the public checkout page.
• Stellar data: Stellar RPC getEvents (live), Horizon only for backfill and wallet checks.
• Payment reference: MEMO_TEXT of PL + 8 Crockford base32 characters, unique across all of PayLink forever.
• Amounts: exact to the stroop by default; partial payments add up until expiry.
• Expiry: default 30 min, allowed range 5 min to 30 days.
• Assets: USDC (Circle testnet issuer GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5) and XLM.
• Wallets: one wallet belongs to one merchant, proven by signing a challenge with Freighter.
• Login: email + password; API keys for creating requests programmatically.
• Non-custodial: PayLink never holds a secret key or moves funds. Refunds are flagged for the merchant to do from their own wallet.
Out of scope
Mainnet, refunds executed by PayLink, fiat pricing, invoices/PDFs, email receipts to customers, an admin panel.
Phases and tasks
Six phases in build order, each ending in a gate check that must pass before the next starts. Days 1–2 are shared with the Webhook build (same server, same Stellar ingestion design); days 3–4 are PayLink's own.
Day
Phases
1
Phase 0 — Foundation
2
Phase 1 — Stellar engine
3
Phase 2 — Requests, matching and API · start Phase 3 — Checkout
4
Finish Phase 3 · Phase 4 — Merchant dashboard
7
Phase 5 — Harden and hand over
Phase 0 — Foundation
[ ] pnpm workspace: apps/api (Express), apps/web (Next.js: dashboard + checkout), packages/shared (Zod schemas + types)
[ ] TypeScript strict, ESLint (rule banning parseFloat/Number() on amounts), Prettier, Vitest
[ ] docker-compose.dev.yml with Postgres 16
[ ] Prisma schema from the Architecture tab + first migration
[ ] Express skeleton: /health, request IDs, pino, error handler, env validation at boot
[ ] GitHub Actions: lint → typecheck → test → build image → GHCR → deploy over SSH
[ ] Server shared with Webhook: separate paylink database + DB user, Caddy route for api.paylink.<domain>
[ ] Design direction picked; tokens in apps/web/DESIGN.md
Gate: a push to main deploys, and https://api.paylink.<domain>/health returns 200 with DB status.
Phase 1 — Stellar engine
[ ] Spike (1 h): payment, path payment, contract-wallet transfer and M-address payment on testnet; confirm getEvents returns amount, asset and memo for each
[ ] StellarSource interface, RpcEventSource, HorizonBackfillSource
[ ] decode.ts → NormalizedPayment; muxed handling; memo normalisation (trim, uppercase, Crockford O→0, I/L→1)
[ ] amount.ts with full tests
[ ] Ingestion loop with cursor, one transaction per batch; watched-wallet set via LISTEN/NOTIFY
[ ] Reconciliation (2 min), watchdog, testnet-reset detection
[ ] scripts/scenario.ts skeleton: Friendbot accounts, trustlines, fake-issuer USDC
Gate: 20 test payments to a watched wallet → exactly 20 ChainPayment rows; kill -9 on the worker mid-run, restart → still 20.
Phase 2 — Requests, matching and API (Deliverable 1)
[ ] Auth (signup, login, sessions), API keys
[ ] Wallets: add, Horizon account + trustline check, Freighter challenge verification, soft delete
[ ] Payment requests: create (memo generation, Idempotency-Key), list, detail, cancel, accept
[ ] transitionRequest() with the allowed-transitions table and row lock
[ ] Matcher: memo → request; wallet, asset, issuer, amount, ledger-time checks; accumulation; every outcome code
[ ] Expiry sweeper using the ledger-time rule
[ ] Unmatched payments list + manual assign
[ ] OpenAPI spec from the Zod schemas; Scalar reference served at /docs
[ ] Tests P1–P21, T1–T7, M1–M9, S1–S5 and tenant isolation
Gate: the scenario script runs every P and T case on testnet and each request ends in the expected status with the expected outcome code.
Phase 3 — Checkout page (Deliverable 2)
[ ] Public /pay/{publicId} per the Frontend tab: amount, wallet, memo, copy buttons, QR (SEP-7), countdown
[ ] "Pay with Freighter": network, trustline and balance pre-checks, then sign and submit
[ ] Live status via SSE with polling fallback; every status screen (paid with tx hash, underpaid with remaining amount, overpaid, expired, cancelled, network reset)
[ ] Tests C1–C8
Gate: on a phone, scan the QR with a testnet wallet, pay, and watch the page flip to Paid with the tx hash, without refreshing.
Phase 4 — Merchant dashboard (Deliverable 3)
[ ] All dashboard screens in the Frontend tab, wired to the API with live updates
[ ] Empty, loading and error states; mobile from 360 px; light and dark
Gate: a new merchant goes from sign-up to a paid request using only the dashboard and checkout.
Phase 5 — Harden and hand over
[ ] Chaos tests pass
[ ] Security checklist fully ticked
[ ] Monitoring + Telegram alerts live; backup restore tested once
[ ] README: setup, env vars, deploy, runbook
[ ] Full scenario run on the live deployment as the demo for David
Gate: Definition of done below is fully ticked.
Definition of done
PayLink is done when every box below is ticked on the live deployment, not just locally.
[ ] All three deliverables pass their phase gates
[ ] Every edge-case ID (P1–P21, T1–T7, M1–M9, C1–C8, S1–S5) has a passing test named with its ID
[ ] npm run lint, typecheck and test green in CI on main
[ ] Live testnet demo: create request → pay from a phone via QR → Paid with tx hash, plus one wrong-asset and one expired example
[ ] Chaos tests pass: no payment missed or double-counted
[ ] Security checklist fully ticked
[ ] HTTPS, monitoring, alerts and nightly off-server backups running; one restore tested
[ ] API reference live at /docs
[ ] Handover: repo access, README, env var list, runbook, credentials shared securely
Bug fixes are free for 60 days after handover; new features and server management are billed separately.