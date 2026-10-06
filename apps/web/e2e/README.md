# Browser checks

Two scripts that drive the real app in headless Chrome against Stellar **Testnet**. They need the
API, the worker and the web app running, and the worker caught up (`/health` shows a small `lagSeconds`).

```sh
WEB_URL=http://localhost:3000 API_URL=http://localhost:4100 pnpm --filter @paylink/web e2e
```

- `walkthrough.mjs`: sign-up, add a wallet, create a request, open the checkout at phone size, pay it in
  two parts on testnet and watch it flip to Paid, then visit every dashboard screen. Screenshots land in
  `e2e/shots/`.
- `freighter.mjs`: clicks the real "Verify with Freighter" and "Pay with Freighter" buttons. The app and
  the `@stellar/freighter-api` library run unchanged; the browser extension is replaced by a stand-in that
  answers the library's messages and signs with a real key. It covers Freighter missing, rejected, on the
  wrong network and on the wrong account, and checks the exact message and transaction Freighter is asked
  to sign.

Neither replaces one manual pass with the real Freighter extension.

## Failure drills

`drills.mjs` breaks things on purpose while a real testnet payment is in flight, and checks the payment
still ends up recorded exactly once. It expects the backend to be running under pm2 and the dev Postgres
in Docker (`paylink-postgres-1`); adjust the commands inside for another setup.

```sh
WEB_URL=… API_URL=… node e2e/drills.mjs            # all four
node e2e/drills.mjs worker,api,reload              # a subset
```

1. `worker`: `kill -9` the worker, pay while it is dead.
2. `api`: `kill -9` the API.
3. `reload`: `pm2 reload` everything (what a deploy does) with a payment in flight.
4. `db`: stop Postgres for 25 seconds and pay during the outage.
