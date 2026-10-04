/**
 * End-to-end scenario on real Stellar Testnet. Doubles as the demo.
 *
 * Needs a running API and worker (`pnpm dev` + `pnpm dev:worker`) whose USDC_ISSUER is the
 * scenario's own issuer account, so the script can mint "USDC" freely:
 *
 *   pnpm scenario -- --print-issuer     # prints USDC_ISSUER=G… ; put it in .env, restart
 *   pnpm scenario                       # runs every case; add --skip-timing to skip the 5-min waits
 *
 * Each case creates a request through the API, pays on-chain, then polls the API until the
 * request status and payment outcome are the expected ones.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Claimant,
  Contract,
  Horizon,
  Keypair,
  Memo,
  MuxedAccount,
  nativeToScVal,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";

const API = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? "4100"}`;
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const HORIZON_URL = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const KEYS_FILE = resolve(__dirname, "../../../.scenario-keys.json");
const args = new Set(process.argv.slice(2));
// --only=P15,P20 runs just those cases (setup still runs).
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",")) : null;

const horizon = new Horizon.Server(HORIZON_URL);
const soroban = new rpc.Server(RPC_URL);

// ---------- keys ----------

interface Keys {
  issuer: Keypair;
  fakeIssuer: Keypair;
}

function loadKeys(): Keys {
  if (existsSync(KEYS_FILE)) {
    const saved = JSON.parse(readFileSync(KEYS_FILE, "utf8")) as { issuer: string; fakeIssuer: string };
    return { issuer: Keypair.fromSecret(saved.issuer), fakeIssuer: Keypair.fromSecret(saved.fakeIssuer) };
  }
  const keys = { issuer: Keypair.random(), fakeIssuer: Keypair.random() };
  // Throwaway testnet keys; the file is gitignored.
  writeFileSync(KEYS_FILE, JSON.stringify({ issuer: keys.issuer.secret(), fakeIssuer: keys.fakeIssuer.secret() }, null, 2), { mode: 0o600 });
  return keys;
}

// ---------- chain helpers ----------

/** Retries transient network failures (testnet endpoints time out now and then). */
async function withRetry<T>(what: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isHttpError = (err as { response?: unknown }).response !== undefined;
      if (isHttpError || attempt >= attempts) throw err;
      console.log(`  (${what}: network error, retry ${attempt}/${attempts - 1})`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

async function friendbot(address: string): Promise<void> {
  const res = await withRetry("friendbot", () => fetch(`https://friendbot.stellar.org?addr=${address}`, { signal: AbortSignal.timeout(60_000) }));
  if (!res.ok && res.status !== 400) throw new Error(`friendbot failed for ${address}: HTTP ${res.status}`);
}

interface SubmitOptions {
  memo?: Memo;
  signers?: Keypair[];
  feeBumpBy?: Keypair;
  /** The transaction is expected to fail on-chain. */
  allowFailure?: boolean;
}

async function submit(source: Keypair, ops: xdr.Operation[], opts: SubmitOptions = {}): Promise<string> {
  const account = await withRetry("load account", () => horizon.loadAccount(source.publicKey()));
  const builder = new TransactionBuilder(account, { fee: (Number.parseInt(BASE_FEE, 10) * 100).toString(), networkPassphrase: PASSPHRASE });
  for (const op of ops) builder.addOperation(op);
  if (opts.memo) builder.addMemo(opts.memo);
  const tx = builder.setTimeout(120).build();
  tx.sign(source, ...(opts.signers ?? []));
  const toSend = opts.feeBumpBy
    ? (() => {
        const fb = TransactionBuilder.buildFeeBumpTransaction(opts.feeBumpBy, (Number.parseInt(BASE_FEE, 10) * 200).toString(), tx, PASSPHRASE);
        fb.sign(opts.feeBumpBy);
        return fb;
      })()
    : tx;
  try {
    const res = await withRetry("submit", () => horizon.submitTransaction(toSend));
    return res.hash;
  } catch (err) {
    if (opts.allowFailure) return Buffer.from(toSend.hash()).toString("hex");
    const extras = (err as { response?: { data?: { extras?: unknown } } }).response?.data?.extras;
    throw new Error(`transaction failed: ${JSON.stringify(extras ?? String(err))}`, { cause: err });
  }
}

const pay = (destination: string, asset: Asset, amount: string) => Operation.payment({ destination, asset, amount });

// ---------- API helpers ----------

class Api {
  private cookie = "";

  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: WEB_ORIGIN, ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0] ?? "";
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
  }

  async ok<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.call<T>(method, path, body);
    if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }
}

interface Req {
  id: string;
  memo: string;
  status: string;
  amountReceived: string;
  paidTxHash: string | null;
  asset: { code: string; issuer: string | null };
}
interface Detail {
  request: Req;
  payments: { outcome: string; txHash: string; innerTxHash: string | null; eventId: string }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => Promise<T | null>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(2000);
  }
}

// ---------- the run ----------

async function main(): Promise<void> {
  const keys = loadKeys();
  if (args.has("--print-issuer")) {
    console.log(`USDC_ISSUER=${keys.issuer.publicKey()}`);
    return;
  }

  const USDC = new Asset("USDC", keys.issuer.publicKey());
  const FAKE_USDC = new Asset("USDC", keys.fakeIssuer.publicKey());
  const XLM = Asset.native();
  const walletKey = Keypair.random();
  const otherWalletKey = Keypair.random();
  const payer = Keypair.random();
  const wallet = walletKey.publicKey();

  console.log("Funding accounts with Friendbot…");
  for (const k of [keys.issuer, keys.fakeIssuer, walletKey, otherWalletKey, payer]) await friendbot(k.publicKey());
  console.log("Trustlines and balances…");
  for (const key of [walletKey, otherWalletKey, payer]) {
    await submit(key, [Operation.changeTrust({ asset: USDC }), Operation.changeTrust({ asset: FAKE_USDC })]);
  }
  await submit(keys.issuer, [pay(payer.publicKey(), USDC, "100000")]);
  await submit(keys.fakeIssuer, [pay(payer.publicKey(), FAKE_USDC, "100000")]);
  // Liquidity for the path payment case: the issuer sells USDC for XLM 1:1.
  await submit(keys.issuer, [Operation.manageSellOffer({ selling: USDC, buying: XLM, amount: "1000", price: "1" })]);

  console.log("Merchant, wallets, verification…");
  const api = new Api();
  const email = `scenario-${Date.now()}@example.com`;
  await api.ok("POST", "/auth/signup", { email, password: "scenario password 123", businessName: "Scenario Shop" });
  async function addWallet(key: Keypair): Promise<string> {
    const added = await api.ok<{ wallet: { id: string } }>("POST", "/v1/wallets", { address: key.publicKey() });
    const ch = await api.ok<{ challengeId: string; message: string }>("POST", `/v1/wallets/${added.wallet.id}/challenge`);
    const signature = Buffer.from(key.signMessage(ch.message)).toString("base64");
    await api.ok("POST", `/v1/wallets/${added.wallet.id}/verify`, { challengeId: ch.challengeId, signature });
    return added.wallet.id;
  }
  const walletId = await addWallet(walletKey);
  const otherWalletId = await addWallet(otherWalletKey);

  const newRequest = async (amount = "5", extra: Record<string, unknown> = {}): Promise<Req> => {
    const res = await api.ok<{ request: Req }>("POST", "/v1/payment-requests", { walletId, amount, asset: "USDC", ...extra });
    return res.request;
  };
  const probe = await newRequest("1");
  if (probe.asset.issuer !== keys.issuer.publicKey()) {
    throw new Error(
      `The API's USDC_ISSUER is ${probe.asset.issuer}, not the scenario issuer.\n` +
        `Set USDC_ISSUER=${keys.issuer.publicKey()} in .env and restart the API and worker.`,
    );
  }
  await api.ok("POST", `/v1/payment-requests/${probe.id}/cancel`);

  /** Waits until the request has the status and the payment from `txHash` has the outcome. */
  const expectRequest = (id: string, status: string, txHash: string | null, outcome: string | null) =>
    until(`request ${status}${outcome ? ` / ${outcome}` : ""}`, async () => {
      const d = await api.ok<Detail>("GET", `/v1/payment-requests/${id}`);
      if (d.request.status !== status) return null;
      if (!txHash || !outcome) return d;
      return d.payments.some((p) => (p.txHash === txHash || p.innerTxHash === txHash) && p.outcome === outcome) ? d : null;
    });
  const expectUnmatched = (txHash: string, outcome: string) =>
    until(`unmatched ${outcome}`, async () => {
      const list = await api.ok<{ data: { txHash: string; outcome: string; eventId: string }[] }>("GET", "/v1/payments?unmatched=true&limit=100");
      return list.data.find((p) => p.txHash === txHash && p.outcome === outcome) ?? null;
    });
  const expectNothing = async (txHash: string) => {
    await sleep(20_000);
    const list = await api.ok<{ data: { txHash: string }[] }>("GET", "/v1/payments?limit=100");
    if (list.data.some((p) => p.txHash === txHash)) throw new Error("a payment was recorded for a failed transaction");
  };

  const results: { id: string; ok: boolean; note: string }[] = [];
  async function run(id: string, title: string, fn: () => Promise<void>): Promise<void> {
    if (only && !only.has(id)) return;
    process.stdout.write(`${id}: ${title} … `);
    try {
      await fn();
      results.push({ id, ok: true, note: title });
      console.log("ok");
    } catch (err) {
      results.push({ id, ok: false, note: `${title}: ${(err as Error).message}` });
      console.log(`FAILED\n    ${(err as Error).message}`);
    }
  }
  const text = (memo: string) => ({ memo: Memo.text(memo) });

  await run("P1", "exact payment -> COUNTED, PAID with tx hash", async () => {
    const r = await newRequest();
    const hash = await submit(payer, [pay(wallet, USDC, "5")], text(r.memo));
    const d = await expectRequest(r.id, "PAID", hash, "COUNTED");
    if (d.request.paidTxHash !== hash) throw new Error("paidTxHash mismatch");
  });
  await run("P2", "no memo -> NO_MEMO, unmatched", async () => {
    const hash = await submit(payer, [pay(wallet, USDC, "1")]);
    await expectUnmatched(hash, "NO_MEMO");
  });
  await run("P3", "unknown memo -> UNKNOWN_MEMO, unmatched", async () => {
    const hash = await submit(payer, [pay(wallet, USDC, "1")], text("PLZZZZZZZZ"));
    await expectUnmatched(hash, "UNKNOWN_MEMO");
  });
  await run("P4", "lowercase memo with separators -> COUNTED", async () => {
    const r = await newRequest();
    const typed = `${r.memo.slice(0, 2)}-${r.memo.slice(2, 6)} ${r.memo.slice(6)}`.toLowerCase();
    const hash = await submit(payer, [pay(wallet, USDC, "5")], text(typed));
    await expectRequest(r.id, "PAID", hash, "COUNTED");
  });
  await run("P5", "MEMO_ID -> MEMO_TYPE_MISMATCH, unmatched", async () => {
    const hash = await submit(payer, [pay(wallet, USDC, "1")], { memo: Memo.id("12345") });
    await expectUnmatched(hash, "MEMO_TYPE_MISMATCH");
  });
  await run("P6", "XLM for a USDC request -> WRONG_ASSET", async () => {
    const r = await newRequest();
    const hash = await submit(payer, [pay(wallet, XLM, "5")], text(r.memo));
    await expectRequest(r.id, "PENDING", hash, "WRONG_ASSET");
  });
  await run("P7", "USDC from another issuer -> WRONG_ISSUER", async () => {
    const r = await newRequest();
    const hash = await submit(payer, [pay(wallet, FAKE_USDC, "5")], text(r.memo));
    await expectRequest(r.id, "PENDING", hash, "WRONG_ISSUER");
  });
  await run("P8", "memo of a request on another wallet -> WRONG_WALLET", async () => {
    const res = await api.ok<{ request: Req }>("POST", "/v1/payment-requests", { walletId: otherWalletId, amount: "5", asset: "USDC" });
    const hash = await submit(payer, [pay(wallet, USDC, "5")], text(res.request.memo));
    await expectRequest(res.request.id, "PENDING", hash, "WRONG_WALLET");
  });
  await run("P9+P10", "partials -> UNDERPAID, then PAID on the exact sum", async () => {
    const r = await newRequest();
    const first = await submit(payer, [pay(wallet, USDC, "2")], text(r.memo));
    await expectRequest(r.id, "UNDERPAID", first, "COUNTED");
    const second = await submit(payer, [pay(wallet, USDC, "3")], text(r.memo));
    await expectRequest(r.id, "PAID", second, "COUNTED");
  });
  await run("P11+P12", "overpay -> OVERPAID; another payment -> DUPLICATE", async () => {
    const r = await newRequest();
    const over = await submit(payer, [pay(wallet, USDC, "6")], text(r.memo));
    await expectRequest(r.id, "OVERPAID", over, "COUNTED");
    const dup = await submit(payer, [pay(wallet, USDC, "1")], text(r.memo));
    await expectRequest(r.id, "OVERPAID", dup, "DUPLICATE");
  });
  await run("P13", "two payment ops in one tx -> both COUNTED, summed", async () => {
    const r = await newRequest();
    const hash = await submit(payer, [pay(wallet, USDC, "2"), pay(wallet, USDC, "3")], text(r.memo));
    const d = await expectRequest(r.id, "PAID", hash, "COUNTED");
    if (d.payments.filter((p) => p.txHash === hash && p.outcome === "COUNTED").length !== 2) throw new Error("expected two COUNTED events");
  });
  await run("P14", "path payment XLM -> USDC counted by USDC received", async () => {
    const r = await newRequest();
    const op = Operation.pathPaymentStrictReceive({ sendAsset: XLM, sendMax: "50", destination: wallet, destAsset: USDC, destAmount: "5", path: [] });
    const hash = await submit(payer, [op], text(r.memo));
    await expectRequest(r.id, "PAID", hash, "COUNTED");
  });
  await run("P15", "Soroban SAC transfer (contract-style payer) -> NO_MEMO, then assign", async () => {
    // Stands in for a contract wallet: the payment is a contract invocation of the asset
    // contract's `transfer`. Soroban transactions cannot carry a memo, so the payment is
    // detected, lands in Unmatched, and the merchant assigns it.
    const sacId = USDC.contractId(PASSPHRASE);
    try {
      const deployer = await soroban.getAccount(keys.issuer.publicKey());
      const deploy = new TransactionBuilder(deployer, { fee: "10000000", networkPassphrase: PASSPHRASE })
        .addOperation(Operation.createStellarAssetContract({ asset: USDC }))
        .setTimeout(120)
        .build();
      const prepared = await soroban.prepareTransaction(deploy);
      prepared.sign(keys.issuer);
      const sent = await soroban.sendTransaction(prepared);
      await soroban.pollTransaction(sent.hash, { attempts: 30 });
    } catch {
      // already deployed on a previous run
    }
    const r = await newRequest();
    const account = await soroban.getAccount(payer.publicKey());
    const tx = new TransactionBuilder(account, { fee: "10000000", networkPassphrase: PASSPHRASE })
      .addOperation(new Contract(sacId).call("transfer", new Address(payer.publicKey()).toScVal(), new Address(wallet).toScVal(), nativeToScVal(50_000_000n, { type: "i128" })))
      .setTimeout(120)
      .build();
    const prepared = await soroban.prepareTransaction(tx);
    prepared.sign(payer);
    const sent = await soroban.sendTransaction(prepared);
    if (sent.status === "ERROR") throw new Error(`sendTransaction rejected: ${JSON.stringify(sent.errorResult)}`);
    await soroban.pollTransaction(sent.hash, { attempts: 30 });
    const payment = await expectUnmatched(sent.hash, "NO_MEMO");
    await api.ok("POST", `/v1/payments/${payment.eventId}/assign`, { requestId: r.id });
    await expectRequest(r.id, "PAID", sent.hash, "COUNTED");
  });
  await run("P16", "payment to the wallet's M-address -> MEMO_TYPE_MISMATCH, then assign", async () => {
    const r = await newRequest();
    const muxed = new MuxedAccount(new Account(wallet, "0"), "42").accountId();
    const hash = await submit(payer, [pay(muxed, USDC, "5")], text(r.memo));
    const payment = await expectUnmatched(hash, "MEMO_TYPE_MISMATCH");
    await api.ok("POST", `/v1/payments/${payment.eventId}/assign`, { requestId: r.id });
    await expectRequest(r.id, "PAID", hash, "COUNTED");
  });
  await run("P17", "payment from the issuer (mint) -> COUNTED", async () => {
    const r = await newRequest();
    const hash = await submit(keys.issuer, [pay(wallet, USDC, "5")], text(r.memo));
    await expectRequest(r.id, "PAID", hash, "COUNTED");
  });
  await run("P18", "one stroop short -> UNDERPAID, never rounded", async () => {
    const r = await newRequest();
    const hash = await submit(payer, [pay(wallet, USDC, "4.9999999")], text(r.memo));
    const d = await expectRequest(r.id, "UNDERPAID", hash, "COUNTED");
    if (d.request.amountReceived !== "4.9999999") throw new Error(`amountReceived ${d.request.amountReceived}`);
  });
  await run("P19", "failed transaction -> nothing recorded", async () => {
    const r = await newRequest();
    // Impossible path payment: fails on-chain (fee charged, no transfer).
    const op = Operation.pathPaymentStrictReceive({ sendAsset: XLM, sendMax: "0.0000001", destination: wallet, destAsset: USDC, destAmount: "5", path: [] });
    const hash = await submit(payer, [op], { ...text(r.memo), allowFailure: true });
    await expectNothing(hash);
    await expectRequest(r.id, "PENDING", null, null);
  });
  await run("P20", "fee-bump transaction -> COUNTED with both hashes", async () => {
    const r = await newRequest();
    const outer = await submit(payer, [pay(wallet, USDC, "5")], { ...text(r.memo), feeBumpBy: keys.fakeIssuer });
    const d = await expectRequest(r.id, "PAID", outer, "COUNTED");
    const p = d.payments.find((x) => x.outcome === "COUNTED");
    if (!p?.innerTxHash || p.innerTxHash === p.txHash) throw new Error("inner hash not stored");
  });
  await run("P21", "claimable balance claim -> NO_MEMO, then assign", async () => {
    const r = await newRequest();
    await submit(payer, [Operation.createClaimableBalance({ asset: USDC, amount: "5", claimants: [new Claimant(wallet)] })]);
    const balances = await until("claimable balance", async () => {
      const page = await horizon.claimableBalances().claimant(wallet).call();
      return page.records[0] ?? null;
    });
    const hash = await submit(walletKey, [Operation.claimClaimableBalance({ balanceId: balances.id })]);
    const payment = await expectUnmatched(hash, "NO_MEMO");
    await api.ok("POST", `/v1/payments/${payment.eventId}/assign`, { requestId: r.id });
    await expectRequest(r.id, "PAID", hash, "COUNTED");
  });
  await run("T4", "payment after cancel -> AFTER_CANCEL", async () => {
    const r = await newRequest();
    await api.ok("POST", `/v1/payment-requests/${r.id}/cancel`);
    const hash = await submit(payer, [pay(wallet, USDC, "5")], text(r.memo));
    await expectRequest(r.id, "CANCELLED", hash, "AFTER_CANCEL");
  });
  await run("T7", "expiry outside 5 min - 30 days -> 400", async () => {
    for (const expiresInMinutes of [4, 43_201]) {
      const res = await api.call("POST", "/v1/payment-requests", { walletId, amount: "5", asset: "USDC", expiresInMinutes });
      if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
    }
  });

  if (!args.has("--skip-timing") && !only) {
    // These need a real expiry, and the shortest allowed is 5 minutes.
    const t1 = await newRequest("5", { expiresInMinutes: 5 });
    const t2 = await newRequest("5", { expiresInMinutes: 5 });
    const t3 = await newRequest("5", { expiresInMinutes: 5 });
    await run("T1", "paid before expiry -> PAID (and stays PAID after expiry)", async () => {
      const hash = await submit(payer, [pay(wallet, USDC, "5")], text(t1.memo));
      await expectRequest(t1.id, "PAID", hash, "COUNTED");
    });
    const partial = await submit(payer, [pay(wallet, USDC, "2")], text(t3.memo));
    await expectRequest(t3.id, "UNDERPAID", partial, "COUNTED");
    console.log("Waiting about 5.5 minutes for requests to expire…");
    await sleep(5.5 * 60_000);
    await run("T3", "partial, then expiry -> EXPIRED with amount received", async () => {
      const d = await expectRequest(t3.id, "EXPIRED", null, null);
      if (d.request.amountReceived !== "2.0000000") throw new Error(`amountReceived ${d.request.amountReceived}`);
    });
    await run("T2", "payment after expiry -> LATE, EXPIRED; Accept -> PAID", async () => {
      const hash = await submit(payer, [pay(wallet, USDC, "5")], text(t2.memo));
      await expectRequest(t2.id, "EXPIRED", hash, "LATE");
      await api.ok("POST", `/v1/payment-requests/${t2.id}/accept`);
      await expectRequest(t2.id, "PAID", hash, "COUNTED");
    });
    await run("T1b", "request paid before expiry is still PAID", async () => {
      await expectRequest(t1.id, "PAID", null, null);
    });
  }

  console.log("\nResults");
  for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.id}  ${r.note}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Merchant login: ${email}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
