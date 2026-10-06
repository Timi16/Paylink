# PayLink

Stellar Testnet payment requests: a merchant creates a request, the customer pays on-chain,
the worker detects and verifies the payment and flips the request to Paid.

**Read everything in /docs before starting any task.** `docs/Build-plan.md`,
`docs/Archiecture.md` and `docs/Backend.md` are the spec.

## Working rules

1. Follow the docs. If something is unclear or seems wrong, ask before building. If we agree on a change, update the matching doc in the same commit.
2. One phase at a time, in order. A phase is done only when its gate check passes.
3. TypeScript strict everywhere; no `any`, no unexplained `@ts-ignore`.
4. Money is never a float: bigint stroops in code, BigInt columns in Postgres, decimal strings in JSON. `parseFloat` and `Number()` on amounts are banned (ESLint enforces it).
5. A payment request's status changes in exactly one function (`transitionRequest` in `apps/api/src/modules/transitions.ts`), which checks the allowed-transitions table and runs inside a transaction holding a row lock on the request. ESLint forbids `status:` in any other `paymentRequest` update.
6. Expiry is judged by ledger close time, never by server clock alone.
7. A memo is never reused anywhere in PayLink, even after its request expires.
8. Every edge-case ID in the docs (P1–P21, T1–T7, M1–M9, C1–C8, S1–S5) gets at least one test whose name starts with that ID.
9. Never log secrets: passwords, API keys, session tokens, full Authorization headers. Never store or log a Stellar secret key, even if a user pastes one.
10. Testnet only: refuse to boot unless the network passphrase is the testnet one.
11. Before saying a task is done, run `pnpm lint`, `pnpm typecheck` and `pnpm test`, and report the results.
12. Small commits with conventional messages (`feat:`, `fix:`, `test:`, `docs:`).

## Layout

- `apps/api` — one codebase, two processes: `src/server.ts` (API) and `src/worker.ts` (ingestion, reconciliation, watchdog, expiry sweeper).
- `apps/web` — Next.js app: landing, auth, dashboard, public checkout (`/pay/[publicId]`). Design system: `apps/web/DESIGN.md`. Amounts stay decimal strings; `parseFloat`/`Number()` are banned there too.
- `packages/shared` — Zod schemas and types shared with the web app.
- `apps/api/scripts` — `scenario.ts` (testnet end-to-end), `seed.ts`; `scripts/chaos.sh`.
- Layering: routes → service → repo. Repos that touch merchant data take `merchantId` first.

## Commands

`pnpm db:up` · `pnpm --filter @paylink/api db:deploy` · `pnpm dev` · `pnpm dev:worker` ·
`pnpm lint` · `pnpm typecheck` · `pnpm test` (needs Docker for Testcontainers) ·
`pnpm scenario` · `pnpm seed` · `pnpm --filter @paylink/api openapi`
