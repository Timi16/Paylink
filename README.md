# PayLink

Payment requests on **Stellar Testnet** (no real money). A merchant creates a request,
PayLink gives it a memo and a checkout link, the customer pays, and the worker detects and
verifies the payment. Wrong, partial, duplicate, late and expired payments are all
recognised and shown, never silently ignored. PayLink is non-custodial: it never holds a
secret key or moves funds.

The spec lives in [docs/](docs/). This repo currently contains the backend.

## Run it locally

Needs Node 22+, pnpm and a Postgres 16 database (`pnpm db:up` starts one in Docker if you have it; otherwise point `DATABASE_URL` at your own).

```sh
pnpm install
cp .env.example .env            # then set SESSION_SECRET: openssl rand -hex 32
pnpm db:up                      # Postgres 16 on localhost:5434
pnpm --filter @paylink/api db:deploy
pnpm dev                        # API on :4100  (reference at /docs)
pnpm dev:worker                 # ingestion, reconciliation, watchdog, expiry sweeper
pnpm seed                       # optional demo data: demo@paylink.test / demo-password-123
```

## Checks

```sh
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm test` starts a throwaway Postgres with Testcontainers when Docker is available; without
Docker, set `TEST_DATABASE_URL` to an empty database and the tests use that instead. Every edge case in the spec has a test named with its ID;
`grep -rhoE '"(P|T|M|C|S)[0-9]+' apps/api/test | sort -u` lists them.

## Proving it on real testnet

```sh
pnpm scenario -- --print-issuer   # prints USDC_ISSUER=G…; put it in .env and restart api + worker
pnpm scenario                     # every P and T case on testnet (about 10 minutes)
pnpm scenario -- --skip-timing    # without the 5-minute expiry waits
```

The scenario uses its own "USDC" issuer so it can mint freely; switch `USDC_ISSUER` back to
Circle's testnet issuer afterwards.

## Environment

See [.env.example](.env.example). `config/env.ts` validates everything at boot and refuses
to start on any network but testnet.

## Deploy (pm2)

The API and the worker are two pm2 processes from one build, defined in
[ecosystem.config.cjs](ecosystem.config.cjs). On the server (Node 22+, pnpm, pm2, Postgres 16):

```sh
git clone <repo> ~/paylink && cd ~/paylink
cp .env.example .env                       # fill in; NODE_ENV=production, real WEB_ORIGIN
pnpm install --frozen-lockfile
pnpm --filter @paylink/api db:deploy
pnpm build
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

Later deploys: `./deploy/deploy.sh <git sha>` pulls, migrates, builds, runs `pm2 reload`,
polls `/health` for 60 s and rolls back to the previous commit if it stays unhealthy.
[.github/workflows/ci.yml](.github/workflows/ci.yml) runs lint, typecheck and tests, then
calls that script over SSH.

- Keep `paylink-api` at **one instance in fork mode**: live updates and the login throttle are in memory.
- Put Caddy in front ([deploy/Caddyfile.snippet](deploy/Caddyfile.snippet)); the API trusts exactly one proxy hop.
- Log rotation: `pm2 install pm2-logrotate`.

## Runbook

| Symptom | What to check |
| --- | --- |
| `/health` is 503 | Postgres is down or unreachable. The worker pauses and resumes by itself. |
| `lagSeconds` keeps growing | Worker logs. RPC down: it backs off (1 s → 30 s) and catches up. Nothing expires while it is behind. |
| "Worker heartbeat is stale" alert | The worker exited so pm2 restarts it; it resumes from the saved cursor. |
| "Testnet reset detected" alert | Expected a few times a year. Open requests were closed as `NETWORK_RESET`; merchants re-create them. |
| "Backfilled ledgers … from Horizon" alert | The worker was down longer than RPC keeps history; the gap was filled from Horizon. |
| A payment is missing | `GET /v1/payments?unmatched=true`: no or wrong memo lands there and can be assigned. |
