import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { sweepExpired } from "../../src/engine/expirySweeper";
import { Ingestion, PAGE_LIMIT } from "../../src/engine/ingestion";
import type { NormalizedPayment } from "../../src/engine/types";
import { Watchdog } from "../../src/engine/watchdog";
import { WatchedWallets } from "../../src/engine/watchedWallets";
import { LiveHub } from "../../src/modules/stream/hub";
import { CapturingAlerter, FakeAccounts, FakeBackfill, FakeStellarSource, PAYER, USDC_ISSUER } from "../helpers/fakes";
import {
  createRequest,
  getPayment,
  getRequest,
  makeApp,
  makeEngine,
  ORIGIN,
  prisma,
  resetDb,
  setupMerchant,
  silentLogger,
  USDC,
  type TestApp,
  type TestEngine,
  type TestMerchant,
  type TestWallet,
} from "../helpers/harness";

let t: TestApp;
let e: TestEngine;
let merchant: TestMerchant;
let wallet: TestWallet;

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const cursor = () => prisma.cursor.findUniqueOrThrow({ where: { name: "rpc-events" } });

beforeAll(() => {
  t = makeApp();
});
beforeEach(async () => {
  await resetDb();
  e = makeEngine();
  ({ merchant, wallet } = await setupMerchant(t));
  await e.ingestion.tick();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("system", () => {
  it("S1: a worker killed mid-batch rolls the whole batch back and replays it; counts are exact", async () => {
    const req = await createRequest(merchant, wallet, { amount: "60" });
    const before = await cursor();
    let crashOn: string | null = null;
    const crashing = makeEngine({
      afterPayment: (p) => {
        if (p.eventId === crashOn) throw new Error("kill -9");
      },
    });
    const made = crashing.source.closeLedger(new Date(), [
      { to: wallet.address, amountStroops: USDC(20), memoRaw: req.memo },
      { to: wallet.address, amountStroops: USDC(20), memoRaw: req.memo },
      { to: wallet.address, amountStroops: USDC(20), memoRaw: req.memo },
    ]);
    crashOn = made[1]!.eventId; // die after the second payment, before the commit
    await expect(crashing.ingestion.tick()).rejects.toThrow("kill -9");

    // Nothing from the dead batch survived, and the cursor did not move.
    expect(await prisma.chainPayment.count()).toBe(0);
    expect(await prisma.requestEvent.count()).toBe(0);
    expect(await getRequest(req.id)).toMatchObject({ status: "PENDING", receivedStroops: 0n });
    expect(await cursor()).toMatchObject({ ledger: before.ledger, pagingToken: before.pagingToken });

    // Restart: the batch replays in full, exactly once.
    crashOn = null;
    await crashing.ingestion.tick();
    await crashing.ingestion.tick(); // and polling again changes nothing
    expect(await prisma.chainPayment.count()).toBe(3);
    expect(await getRequest(req.id)).toMatchObject({ status: "PAID", receivedStroops: USDC(60) });
    expect((await cursor()).ledger).toBe(crashing.source.ledger);
  });

  it("S1: 20 payments, a crash and a restart from the saved cursor still give exactly 20 rows", async () => {
    const a = makeEngine();
    for (let i = 0; i < 12; i++) a.source.closeLedger(new Date(), [{ to: wallet.address, amountStroops: USDC(1) }]);
    await a.ingestion.tick();
    expect(await prisma.chainPayment.count()).toBe(12);
    // New worker process (fresh memory), same chain, 8 more payments.
    const restarted = new Ingestion({
      prisma,
      source: a.source,
      backfill: a.backfill,
      watched: new WatchedWallets(prisma, 0),
      alerter: a.alerter,
      logger: silentLogger,
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    for (let i = 0; i < 8; i++) a.source.closeLedger(new Date(), [{ to: wallet.address, amountStroops: USDC(1) }]);
    await restarted.tick();
    await restarted.tick();
    expect(await prisma.chainPayment.count()).toBe(20);
    expect(await restarted.reconcile()).toBe(0);
    expect(await prisma.chainPayment.count()).toBe(20);
  });

  it("S1: a burst larger than one page is paged without loss or double counting", async () => {
    const req = await createRequest(merchant, wallet, { amount: "450" });
    const total = PAGE_LIMIT * 2 + 50;
    // Mostly other people's payments, with ours spread through several ledgers.
    for (let ledger = 0; ledger < 9; ledger++) {
      const batch = Array.from({ length: total / 9 }, (_, i) =>
        i % 10 === 0
          ? { to: wallet.address, amountStroops: USDC(1), memoRaw: req.memo }
          : { to: PAYER, amountStroops: USDC(1) },
      );
      e.source.closeLedger(new Date(), batch);
    }
    let ticks = 0;
    while ((await e.ingestion.tick()).full) ticks++;
    expect(ticks).toBeGreaterThanOrEqual(2);
    const mine = Math.ceil(total / 9 / 10) * 9;
    expect(await prisma.chainPayment.count()).toBe(mine);
    expect((await getRequest(req.id)).receivedStroops).toBe(USDC(mine));
    expect((await cursor()).ledger).toBe(e.source.ledger);
  });

  it("S2: with RPC down the cursor holds, nothing expires early, and recovery catches up in full", async () => {
    const req = await createRequest(merchant, wallet);
    const late = await createRequest(merchant, wallet);
    const before = await cursor();

    e.source.failing = true; // RPC down or rate-limited
    // Meanwhile the chain moves on: an on-time payment for `req`...
    e.source.closeLedger(ago(10 * MIN), [{ to: wallet.address, amountStroops: USDC(50), memoRaw: req.memo }]);
    // ...and both requests pass their expiry by the wall clock.
    await prisma.paymentRequest.updateMany({ data: { expiresAt: ago(5 * MIN) } });
    e.source.closeLedger(ago(1 * MIN), [{ to: wallet.address, amountStroops: USDC(50), memoRaw: late.memo }]);

    for (let i = 0; i < 3; i++) await expect(e.ingestion.tick()).rejects.toThrow("rpc unavailable");
    expect(await cursor()).toMatchObject({ ledger: before.ledger, pagingToken: before.pagingToken });
    expect(await sweepExpired(prisma)).toBe(0); // the sweeper waits for ingestion
    expect((await getRequest(req.id)).status).toBe("PENDING");

    e.source.failing = false;
    await e.ingestion.tick();
    expect(await getRequest(req.id)).toMatchObject({ status: "PAID", receivedStroops: USDC(50) });
    expect((await getRequest(late.id)).status).toBe("EXPIRED");
    expect((await prisma.chainPayment.findFirstOrThrow({ where: { requestId: late.id } })).outcome).toBe("LATE");
    expect((await cursor()).ledger).toBe(e.source.ledger);
  });

  it("S2: the watchdog alerts after 2 minutes of lag, once, and reports recovery", async () => {
    let now = Date.now();
    let stale = 0;
    const watchdog = new Watchdog({ ingestion: e.ingestion, source: e.source, alerter: e.alerter, logger: silentLogger, onStale: () => stale++, now: () => now });
    e.ingestion.lastTickAt = now;
    expect(await watchdog.check()).toMatchObject({ lagLedgers: 0, stale: false });

    for (let i = 0; i < 20; i++) e.source.closeLedger(); // chain moves, worker does not
    expect((await watchdog.check()).lagLedgers).toBe(20);
    expect(e.alerter.messages).toEqual([]); // not yet 2 minutes
    now += 121_000;
    e.ingestion.lastTickAt = now;
    await watchdog.check();
    await watchdog.check();
    expect(e.alerter.messages).toEqual([expect.stringContaining("lagging")]);

    await e.ingestion.tick();
    e.ingestion.lastTickAt = now;
    await watchdog.check();
    expect(e.alerter.messages.at(-1)).toContain("caught up");

    // RPC unreachable counts as lag; a hung loop triggers the restart hook.
    e.source.failing = true;
    expect((await watchdog.check()).stale).toBe(false);
    now += 200_000;
    expect((await watchdog.check()).stale).toBe(true);
    expect(stale).toBe(1);
    expect(e.alerter.messages.at(-1)).toContain("heartbeat");
  });

  it("S3: with Postgres down the API answers 503 and the worker pauses without advancing the cursor", async () => {
    const deadDb = new PrismaClient({ datasourceUrl: "postgresql://nobody:nothing@127.0.0.1:1/none?connect_timeout=1" });
    const dead = buildApp({ prisma: deadDb, accounts: new FakeAccounts(), hub: new LiveHub(deadDb, silentLogger), logger: silentLogger });

    const health = await request(dead.app).get("/health");
    expect(health.status).toBe(503);
    expect(health.body).toMatchObject({ status: "degraded", db: "down" });
    const api = await request(dead.app).get("/public/pay/aaaaaaaaaaaa");
    expect(api.status).toBe(503);
    expect(api.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(api.headers["retry-after"]).toBeDefined();
    const login = await request(dead.app).post("/auth/login").set("Origin", ORIGIN).send({ email: "a@b.example", password: "whatever it is" });
    expect(login.status).toBe(503);
    expect(JSON.stringify(login.body)).not.toMatch(/127\.0\.0\.1|prisma|nobody/i); // no internals leak

    const before = await cursor();
    const source = new FakeStellarSource();
    source.closeLedger(new Date(), [{ to: wallet.address, amountStroops: USDC(1) }]);
    const worker = new Ingestion({ prisma: deadDb, source, backfill: new FakeBackfill(), watched: new WatchedWallets(deadDb, 0), alerter: new CapturingAlerter(), logger: silentLogger, networkPassphrase: "Test SDF Network ; September 2015" });
    await expect(worker.tick()).rejects.toThrow();
    await expect(sweepExpired(deadDb)).rejects.toThrow();
    expect(await cursor()).toMatchObject({ ledger: before.ledger, pagingToken: before.pagingToken });
    expect(await prisma.chainPayment.count()).toBe(0);
    await deadDb.$disconnect();
  });

  it("S4: after a reboot the worker resumes from the saved cursor and misses nothing", async () => {
    const req = await createRequest(merchant, wallet, { amount: "3" });
    await e.pay({ to: wallet.address, amountStroops: USDC(1), memoRaw: req.memo });
    const saved = await cursor();
    // Server is down while two more ledgers close.
    e.source.closeLedger(new Date(), [{ to: wallet.address, amountStroops: USDC(1), memoRaw: req.memo }]);
    e.source.closeLedger(new Date(), [{ to: wallet.address, amountStroops: USDC(1), memoRaw: req.memo }]);
    // Boot: a brand-new process with nothing in memory.
    const fresh = new Ingestion({ prisma, source: e.source, backfill: e.backfill, watched: new WatchedWallets(prisma), alerter: e.alerter, logger: silentLogger, networkPassphrase: "Test SDF Network ; September 2015" });
    expect((await fresh.loadCursor())?.pagingToken).toBe(saved.pagingToken);
    await fresh.tick();
    expect(await prisma.chainPayment.count()).toBe(3);
    expect(await getRequest(req.id)).toMatchObject({ status: "PAID", receivedStroops: USDC(3) });
  });

  it("S4: down for longer than RPC retention: the gap is backfilled from Horizon with no double counting", async () => {
    const req = await createRequest(merchant, wallet, { amount: "30" });
    const [seen] = await e.pay({ to: wallet.address, amountStroops: USDC(10), memoRaw: req.memo, txHash: "aa".repeat(32) });
    const base: NormalizedPayment = { ...seen!, source: "horizon" };
    // RPC has forgotten everything before ledger 5000.
    e.source.ledger = 6000;
    e.source.oldestLedger = 5000;
    e.backfill.byAddress.set(wallet.address, [
      // The payment RPC already delivered, as Horizon reports it (different id, same tx).
      { ...base, eventId: "hz-1-0" },
      { ...base, eventId: "hz-2-0", ledger: 2000, txHash: "bb".repeat(32), ledgerClosedAt: new Date() },
      { ...base, eventId: "hz-3-0", ledger: 3000, txHash: "cc".repeat(32), ledgerClosedAt: new Date() },
    ]);
    const result = await e.ingestion.tick();
    expect(result.processed).toBe(2);
    expect(e.backfill.calls[0]).toMatchObject({ address: wallet.address, to: 5019 });
    expect(await prisma.chainPayment.count()).toBe(3);
    expect(await getRequest(req.id)).toMatchObject({ status: "PAID", receivedStroops: USDC(30) });
    expect(await cursor()).toMatchObject({ ledger: 5019, pagingToken: null });
    expect(e.alerter.messages.at(-1)).toContain("Backfilled");
    // Live ingestion continues from RPC at the boundary, and reconciliation finds nothing new.
    await e.pay({ to: wallet.address, amountStroops: USDC(1) });
    expect(await prisma.chainPayment.count()).toBe(4);
    expect(await e.ingestion.reconcile()).toBe(0);
  });

  it("S5: a testnet reset closes open requests as NETWORK_RESET, later payments are AFTER_RESET, and an alert goes out", async () => {
    const open = await createRequest(merchant, wallet);
    const partial = await createRequest(merchant, wallet);
    const paid = await createRequest(merchant, wallet);
    const [old] = await e.pay([
      { to: wallet.address, amountStroops: USDC(50), memoRaw: paid.memo },
      { to: wallet.address, amountStroops: USDC(10), memoRaw: partial.memo },
    ]);

    e.source.reset(10); // tip far behind the cursor: the network was wiped
    // One odd answer is not enough to close every open request: it takes 3 polls in a row.
    await e.ingestion.tick();
    await e.ingestion.tick();
    expect((await getRequest(open.id)).status).toBe("PENDING");
    expect(e.alerter.messages).toEqual([]);
    await e.ingestion.tick();

    expect((await getRequest(open.id)).status).toBe("NETWORK_RESET");
    expect(await getRequest(partial.id)).toMatchObject({ status: "NETWORK_RESET", receivedStroops: USDC(10) });
    expect((await getRequest(paid.id)).status).toBe("PAID"); // final states are untouched
    expect(e.alerter.messages).toEqual([expect.stringContaining("Testnet reset detected. 2 open request(s)")]);
    const c = await cursor();
    expect(c).toMatchObject({ ledger: 10, pagingToken: null });
    expect(c.lastNetworkResetAt).not.toBeNull();
    const audit = await prisma.requestEvent.findFirstOrThrow({ where: { requestId: open.id } });
    expect(audit).toMatchObject({ toStatus: "NETWORK_RESET", reason: "network_reset", actor: "system" });

    // Old event ids were moved aside, so a new event that reuses one is not dropped.
    expect(await prisma.chainPayment.findUnique({ where: { eventId: old!.eventId } })).toBeNull();
    const [after] = await e.pay({ to: wallet.address, amountStroops: USDC(50), memoRaw: open.memo });
    expect(await getPayment(after!.eventId)).toMatchObject({ outcome: "AFTER_RESET", requestId: open.id });
    expect((await getRequest(open.id)).status).toBe("NETWORK_RESET");

    // NETWORK_RESET is final for the merchant too, and new requests work on the new network.
    expect((await merchant.agent.post(`/v1/payment-requests/${open.id}/cancel`).set("Origin", ORIGIN)).status).toBe(409);
    expect((await merchant.agent.post(`/v1/payment-requests/${open.id}/accept`).set("Origin", ORIGIN)).status).toBe(409);
    const fresh = await createRequest(merchant, wallet);
    await e.pay({ to: wallet.address, amountStroops: USDC(50), memoRaw: fresh.memo });
    expect((await getRequest(fresh.id)).status).toBe("PAID");
    // A small rewind (under 100 ledgers) is not treated as a reset.
    expect(await prisma.paymentRequest.count({ where: { status: "NETWORK_RESET" } })).toBe(2);
  });

  it("S5: a stale RPC node reporting an old tip is an RPC fault, not a reset: nothing is closed", async () => {
    const open = await createRequest(merchant, wallet);
    const [p] = await e.pay({ to: wallet.address, amountStroops: USDC(1) });
    const before = await cursor();
    for (let i = 0; i < 150; i++) e.source.closeLedger();
    await e.ingestion.tick();
    const real = e.source.ledger;
    // A lagging node answers: its tip is 150 ledgers back and closed 12 minutes ago.
    e.source.staleTip = { ledger: real - 150, closedAt: new Date(Date.now() - 12 * 60_000) };
    for (let i = 0; i < 5; i++) await expect(e.ingestion.tick()).rejects.toThrow(/stale/);
    expect((await getRequest(open.id)).status).toBe("PENDING");
    expect(await prisma.chainPayment.findUnique({ where: { eventId: p!.eventId } })).not.toBeNull(); // ids untouched
    expect((await cursor()).ledger).toBe(real);
    expect(before.lastNetworkResetAt).toBeNull();
    expect((await cursor()).lastNetworkResetAt).toBeNull();
    expect(e.alerter.messages).toEqual([]);
    // The healthy node answers again and everything carries on.
    e.source.staleTip = null;
    await e.pay({ to: wallet.address, amountStroops: USDC(50), memoRaw: open.memo });
    expect((await getRequest(open.id)).status).toBe("PAID");
  });

  it("S5: payments from before a reset cannot be assigned to requests created after it", async () => {
    const [old] = await e.pay({ to: wallet.address, amountStroops: USDC(50) }); // unmatched, pre-reset
    e.source.reset(10);
    for (let i = 0; i < 3; i++) await e.ingestion.tick();
    const fresh = await createRequest(merchant, wallet);
    const renamed = await prisma.chainPayment.findFirstOrThrow({ where: { txHash: old!.txHash } });
    expect(renamed.eventId).toMatch(/^reset-/);
    const res = await merchant.agent.post(`/v1/payments/${renamed.eventId}/assign`).set("Origin", ORIGIN).send({ requestId: fresh.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PAYMENT_NOT_ASSIGNABLE");
    expect((await getRequest(fresh.id)).status).toBe("PENDING");
  });

  it("S4: a long Horizon backfill keeps the worker heartbeat alive, so the watchdog does not kill it mid-way", async () => {
    e.source.ledger = 6000;
    e.source.oldestLedger = 5000;
    e.ingestion.lastTickAt = 0; // as if the previous tick finished long ago
    let seenDuringBackfill = 0;
    const original = e.backfill.payments.bind(e.backfill);
    e.backfill.payments = (address, from, to) => {
      seenDuringBackfill = e.ingestion.lastTickAt;
      return original(address, from, to);
    };
    await e.ingestion.tick();
    expect(seenDuringBackfill).toBeGreaterThan(Date.now() - 5000);
  });

  it("reconciliation recovers a payment made just before its wallet was registered", async () => {
    const stranger = await setupMerchant(t, "Late Joiner");
    // Pretend the wallet was not watched when the payment's ledger was processed.
    await prisma.wallet.update({ where: { id: stranger.wallet.id }, data: { deletedAt: new Date() } });
    const [missed] = await e.pay({ to: stranger.wallet.address, amountStroops: USDC(7), assetIssuer: USDC_ISSUER });
    expect(await prisma.chainPayment.findUnique({ where: { eventId: missed!.eventId } })).toBeNull();
    await prisma.wallet.update({ where: { id: stranger.wallet.id }, data: { deletedAt: null } });

    expect(await e.ingestion.reconcile()).toBe(1);
    expect(await getPayment(missed!.eventId)).toMatchObject({ outcome: "NO_MEMO", walletId: stranger.wallet.id });
    expect(await e.ingestion.reconcile()).toBe(0); // idempotent
  });
});
