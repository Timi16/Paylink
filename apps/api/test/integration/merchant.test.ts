import { Keypair } from "@stellar/stellar-sdk";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FAKE_ISSUER, usdcTrustline } from "../helpers/fakes";
import {
  addVerifiedWallet,
  createRequest,
  makeApp,
  makeEngine,
  ORIGIN,
  prisma,
  resetDb,
  signup,
  USDC,
  type TestApp,
  type TestMerchant,
} from "../helpers/harness";

let t: TestApp;
let m: TestMerchant;

beforeAll(() => {
  t = makeApp();
});
beforeEach(async () => {
  await resetDb();
  t.accounts.states.clear();
  t.accounts.down = false;
  m = await signup(t);
});
afterAll(async () => {
  await prisma.$disconnect();
});

const post = (path: string, body?: object) => m.agent.post(path).set("Origin", ORIGIN).send(body);
const create = (walletId: string, body: Record<string, unknown> = {}) =>
  post("/v1/payment-requests", { walletId, amount: "50", asset: "USDC", ...body });

describe("merchant setup: wallets", () => {
  it("M1: an invalid address, an M-address or a pasted S… secret is 400, and the secret is never stored", async () => {
    const secret = Keypair.random().secret();
    const res = await post("/v1/wallets", { address: secret });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SECRET_KEY_REJECTED");
    expect(JSON.stringify(res.body)).not.toContain(secret);

    const muxed = await post("/v1/wallets", { address: "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK" });
    expect(muxed.status).toBe(400);
    expect(muxed.body.error.code).toBe("VALIDATION_FAILED");
    for (const address of ["GABC", "", "not-an-address", Keypair.random().publicKey().slice(0, 55) + "A"]) {
      const bad = await post("/v1/wallets", { address });
      expect(bad.status, address).toBe(400);
    }
    expect(await prisma.wallet.count()).toBe(0);
    // Nothing anywhere in the database contains the secret.
    const dump = JSON.stringify(await prisma.$queryRawUnsafe('SELECT * FROM "Wallet"'));
    expect(dump).not.toContain(secret);
  });

  it("adds a wallet unverified, with account and trustline data from Horizon", async () => {
    const kp = Keypair.random();
    const res = await post("/v1/wallets", { address: ` ${kp.publicKey()} `, label: "Till 1" });
    expect(res.status).toBe(201);
    expect(res.body.wallet).toMatchObject({
      address: kp.publicKey(),
      label: "Till 1",
      verified: false,
      accountExists: true,
      canReceive: { USDC: { canReceive: true, reason: null }, XLM: { canReceive: true, reason: null } },
    });
    expect(res.body.wallet.checkedAt).toBeTruthy();
  });

  it("still adds the wallet when Horizon is down, and refresh reports 503 until it is back", async () => {
    t.accounts.down = true;
    const res = await post("/v1/wallets", { address: Keypair.random().publicKey() });
    expect(res.status).toBe(201);
    expect(res.body.wallet).toMatchObject({ accountExists: false, checkedAt: null });
    const refresh = await post(`/v1/wallets/${res.body.wallet.id}/refresh`);
    expect(refresh.status).toBe(503);
    expect(refresh.body.error.code).toBe("HORIZON_UNAVAILABLE");
    t.accounts.down = false;
    const ok = await post(`/v1/wallets/${res.body.wallet.id}/refresh`);
    expect(ok.body.wallet).toMatchObject({ accountExists: true });
  });

  it("requests can only be created on a verified wallet", async () => {
    const added = await post("/v1/wallets", { address: Keypair.random().publicKey() });
    const res = await create(added.body.wallet.id);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "WALLET_NOT_VERIFIED", message: "Verify this wallet before creating requests" });
  });

  it("verifies ownership with a signed challenge: single use, 10-minute expiry, right signer only", async () => {
    const kp = Keypair.random();
    const added = await post("/v1/wallets", { address: kp.publicKey() });
    const id = added.body.wallet.id as string;
    const challenge = await post(`/v1/wallets/${id}/challenge`);
    expect(challenge.status).toBe(200);
    const { challengeId, message, expiresAt } = challenge.body;
    expect(message).toContain("PayLink wallet verification");
    expect(message).toContain(`Merchant: ${m.id}`);
    expect(message).toContain(`Wallet: ${kp.publicKey()}`);
    expect(message).toMatch(/Nonce: [0-9a-f]{32}/);
    const ttl = new Date(expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);

    const sign = (key: Keypair, text: string) => Buffer.from(key.signMessage(text)).toString("base64");
    // Wrong signer, tampered message, garbage.
    for (const signature of [sign(Keypair.random(), message), sign(kp, message + " "), "AAAA", "zz".repeat(64)]) {
      const bad = await post(`/v1/wallets/${id}/verify`, { challengeId, signature });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("INVALID_SIGNATURE");
    }
    expect((await post(`/v1/wallets/${id}/verify`, { challengeId: "missing", signature: sign(kp, message) })).status).toBe(404);

    const ok = await post(`/v1/wallets/${id}/verify`, { challengeId, signature: sign(kp, message) });
    expect(ok.status).toBe(200);
    expect(ok.body.wallet.verified).toBe(true);
    // Replay of a used challenge.
    const replay = await post(`/v1/wallets/${id}/verify`, { challengeId, signature: sign(kp, message) });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe("CHALLENGE_EXPIRED");

    // An expired challenge.
    const second = await post(`/v1/wallets/${id}/challenge`);
    await prisma.walletChallenge.update({ where: { id: second.body.challengeId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await post(`/v1/wallets/${id}/verify`, { challengeId: second.body.challengeId, signature: sign(kp, second.body.message) });
    expect(expired.body.error.code).toBe("CHALLENGE_EXPIRED");
  });

  it("a challenge issued for one wallet cannot verify another", async () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const wa = await post("/v1/wallets", { address: a.publicKey() });
    const wb = await post("/v1/wallets", { address: b.publicKey() });
    const challenge = await post(`/v1/wallets/${wa.body.wallet.id}/challenge`);
    const signature = Buffer.from(b.signMessage(challenge.body.message)).toString("base64");
    const res = await post(`/v1/wallets/${wb.body.wallet.id}/verify`, { challengeId: challenge.body.challengeId, signature });
    expect(res.status).toBe(404);
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: wb.body.wallet.id } })).verifiedAt).toBeNull();
  });

  it("M2: an account that does not exist blocks request creation with ACCOUNT_NOT_FOUND", async () => {
    const wallet = await addVerifiedWallet(m);
    t.accounts.states.set(wallet.address, { exists: false });
    await post(`/v1/wallets/${wallet.id}/refresh`);
    for (const asset of ["USDC", "XLM"]) {
      const res = await create(wallet.id, { asset });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("ACCOUNT_NOT_FOUND");
    }
  });

  it("M3: no USDC trustline is NO_TRUSTLINE on create, and canReceive: false on the checkout", async () => {
    const wallet = await addVerifiedWallet(m);
    const open = await createRequest(m, wallet); // created while the trustline existed
    t.accounts.states.set(wallet.address, { exists: true, trustlines: [usdcTrustline({ issuer: FAKE_ISSUER })] });
    await post(`/v1/wallets/${wallet.id}/refresh`);

    const res = await create(wallet.id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("NO_TRUSTLINE");
    expect((await create(wallet.id, { asset: "XLM" })).status).toBe(201); // XLM needs no trustline

    const checkout = await request(t.app).get(`/public/pay/${open.publicId}`);
    expect(checkout.body).toMatchObject({ canReceive: false, cannotReceiveReason: "NO_TRUSTLINE", status: "PENDING" });
    const list = await m.agent.get("/v1/wallets");
    expect(list.body.data[0].canReceive.USDC).toEqual({ canReceive: false, reason: "NO_TRUSTLINE" });
  });

  it("M4: an amount above the trustline headroom is TRUSTLINE_LIMIT_TOO_LOW", async () => {
    const wallet = await addVerifiedWallet(m);
    t.accounts.states.set(wallet.address, { exists: true, trustlines: [usdcTrustline({ limit: "100.0000000", balance: "60.0000000" })] });
    await post(`/v1/wallets/${wallet.id}/refresh`);
    const tooMuch = await create(wallet.id, { amount: "40.0000001" });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.code).toBe("TRUSTLINE_LIMIT_TOO_LOW");
    const fits = await create(wallet.id, { amount: "40" });
    expect(fits.status).toBe(201);
    // The wallet then fills up: the open request's checkout warns the payer.
    t.accounts.states.set(wallet.address, { exists: true, trustlines: [usdcTrustline({ limit: "100.0000000", balance: "90.0000000" })] });
    await prisma.wallet.update({ where: { id: wallet.id }, data: { checkedAt: new Date(Date.now() - 60_000) } });
    const checkout = await request(t.app).get(`/public/pay/${fits.body.request.publicId}`);
    expect(checkout.body).toMatchObject({ canReceive: false, cannotReceiveReason: "TRUSTLINE_LIMIT_TOO_LOW" });
  });

  it("re-checks the wallet on create only when the cached check is older than 5 minutes; Horizon down falls back to the cache", async () => {
    const wallet = await addVerifiedWallet(m);
    const before = t.accounts.calls;
    expect((await create(wallet.id)).status).toBe(201);
    expect(t.accounts.calls).toBe(before); // fresh cache: no Horizon call
    await prisma.wallet.update({ where: { id: wallet.id }, data: { checkedAt: new Date(Date.now() - 6 * 60_000) } });
    expect((await create(wallet.id)).status).toBe(201);
    expect(t.accounts.calls).toBe(before + 1);
    await prisma.wallet.update({ where: { id: wallet.id }, data: { checkedAt: new Date(Date.now() - 6 * 60_000) } });
    t.accounts.down = true;
    expect((await create(wallet.id)).status).toBe(201); // stale data beats refusing to sell
  });

  it("M5: a wallet removed with open requests is soft-deleted, still watched, and requests keep their snapshot", async () => {
    const wallet = await addVerifiedWallet(m);
    const req = await createRequest(m, wallet);
    const del = await m.agent.delete(`/v1/wallets/${wallet.id}`).set("Origin", ORIGIN);
    expect(del.status).toBe(204);
    expect((await m.agent.get("/v1/wallets")).body.data).toHaveLength(0);
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).deletedAt).not.toBeNull();
    expect((await create(wallet.id)).status).toBe(404); // no new requests on a removed wallet
    expect((await post(`/v1/wallets/${wallet.id}/challenge`)).status).toBe(404);

    const e = makeEngine();
    await e.ingestion.tick();
    expect(e.watched.has(wallet.address)).toBe(true);
    await e.pay({ to: wallet.address, amountStroops: USDC(50), memoRaw: req.memo });
    const detail = await m.agent.get(`/v1/payment-requests/${req.id}`);
    expect(detail.body.request).toMatchObject({ status: "PAID", wallet: wallet.address });

    // With no open requests left it drops out of the watched set.
    await e.watched.refresh();
    expect(e.watched.has(wallet.address)).toBe(false);
    // The same merchant can add it back; it is restored, still verified.
    const again = await post("/v1/wallets", { address: wallet.address });
    expect(again.status).toBe(201);
    expect(again.body.wallet).toMatchObject({ id: wallet.id, verified: true });
  });

  it("M6: a wallet already owned by another merchant is 409 WALLET_TAKEN (even after they removed it)", async () => {
    const wallet = await addVerifiedWallet(m);
    const other = await signup(t, "Other");
    const res = await other.agent.post("/v1/wallets").set("Origin", ORIGIN).send({ address: wallet.address });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("WALLET_TAKEN");
    expect((await post("/v1/wallets", { address: wallet.address })).status).toBe(409); // own duplicate
    await m.agent.delete(`/v1/wallets/${wallet.id}`).set("Origin", ORIGIN);
    const after = await other.agent.post("/v1/wallets").set("Origin", ORIGIN).send({ address: wallet.address });
    expect(after.status).toBe(409);
  });

  it("M6: an unverified claim cannot squat on an address: the next merchant takes it, and verification settles it", async () => {
    const owner = Keypair.random();
    const squatter = await signup(t, "Squatter");
    const squat = await squatter.agent.post("/v1/wallets").set("Origin", ORIGIN).send({ address: owner.publicKey() });
    expect(squat.status).toBe(201);
    const staleChallenge = await squatter.agent.post(`/v1/wallets/${squat.body.wallet.id}/challenge`).set("Origin", ORIGIN);

    // The real owner can still add and verify it.
    const mine = await addVerifiedWallet(m, owner);
    expect((await squatter.agent.get("/v1/wallets")).body.data).toEqual([]);
    expect(await prisma.wallet.count({ where: { address: owner.publicKey() } })).toBe(1);
    // The squatter's old challenge is useless, even with a valid signature.
    const signature = Buffer.from(owner.signMessage(staleChallenge.body.message)).toString("base64");
    const replay = await squatter.agent.post(`/v1/wallets/${mine.id}/verify`).set("Origin", ORIGIN).send({ challengeId: staleChallenge.body.challengeId, signature });
    expect(replay.status).toBe(404);
    // Once verified it cannot be taken.
    const again = await squatter.agent.post("/v1/wallets").set("Origin", ORIGIN).send({ address: owner.publicKey() });
    expect(again.status).toBe(409);
    expect((await prisma.wallet.findFirstOrThrow({ where: { address: owner.publicKey() } })).merchantId).toBe(m.id);
  });

  it("M6: two merchants adding the same wallet at once leave exactly one row with one owner", async () => {
    const other = await signup(t, "Other");
    const address = Keypair.random().publicKey();
    const [a, b] = await Promise.all([
      post("/v1/wallets", { address }),
      other.agent.post("/v1/wallets").set("Origin", ORIGIN).send({ address }),
    ]);
    expect([201, 409]).toContain(a.status);
    expect([201, 409]).toContain(b.status);
    expect([a.status, b.status]).toContain(201);
    expect(await prisma.wallet.count({ where: { address } })).toBe(1);
    const mine = (await m.agent.get("/v1/wallets")).body.data.length;
    const theirs = (await other.agent.get("/v1/wallets")).body.data.length;
    expect(mine + theirs).toBe(1);
  });
});

describe("merchant setup: creating requests", () => {
  it("creates a request with a snapshot, a unique memo, a public id and a checkout URL", async () => {
    const wallet = await addVerifiedWallet(m);
    const res = await create(wallet.id, { description: " Order #1042 ", customerRef: "ord_1042", metadata: { cart: [1, 2], vip: true } });
    expect(res.status).toBe(201);
    const r = res.body.request;
    expect(r).toMatchObject({
      status: "PENDING",
      wallet: wallet.address,
      asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      amount: "50.0000000",
      amountStroops: "500000000",
      amountReceived: "0.0000000",
      amountRemaining: "50.0000000",
      paidTxHash: null,
      description: "Order #1042",
      customerRef: "ord_1042",
      metadata: { cart: [1, 2], vip: true },
      createdVia: "dashboard",
      refundOwed: false,
    });
    expect(r.memo).toMatch(/^PL[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(r.publicId).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(res.body.checkoutUrl).toBe(`${ORIGIN}/pay/${r.publicId}`);
  });

  it("memos and public ids are never reused across requests", async () => {
    const wallet = await addVerifiedWallet(m);
    const made = await Promise.all(Array.from({ length: 25 }, () => create(wallet.id)));
    expect(made.every((r) => r.status === 201)).toBe(true);
    expect(new Set(made.map((r) => r.body.request.memo)).size).toBe(25);
    expect(new Set(made.map((r) => r.body.request.publicId)).size).toBe(25);
  });

  it("M7: the same Idempotency-Key twice returns the same request with 200; a different body is 409", async () => {
    const wallet = await addVerifiedWallet(m);
    const send = (body: Record<string, unknown>, key = "order-1042") =>
      m.agent.post("/v1/payment-requests").set("Origin", ORIGIN).set("Idempotency-Key", key).send({ walletId: wallet.id, asset: "USDC", ...body });
    const first = await send({ amount: "50" });
    expect(first.status).toBe(201);
    const again = await send({ amount: "50" });
    expect(again.status).toBe(200);
    expect(again.body.request.id).toBe(first.body.request.id);
    expect(again.body.checkoutUrl).toBe(first.body.checkoutUrl);
    // Equivalent body: explicit default and different key order.
    const equivalent = await m.agent.post("/v1/payment-requests").set("Origin", ORIGIN).set("Idempotency-Key", "order-1042").send({ expiresInMinutes: 30, asset: "USDC", amount: "50", walletId: wallet.id });
    expect(equivalent.status).toBe(200);

    const different = await send({ amount: "51" });
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe("IDEMPOTENCY_MISMATCH");
    expect((await send({ amount: "51" }, "order-1043")).status).toBe(201);
    expect(await prisma.paymentRequest.count()).toBe(2);

    // Keys are per merchant.
    const other = await signup(t, "Other");
    const otherWallet = await addVerifiedWallet(other);
    const theirs = await other.agent.post("/v1/payment-requests").set("Origin", ORIGIN).set("Idempotency-Key", "order-1042").send({ walletId: otherWallet.id, asset: "USDC", amount: "50" });
    expect(theirs.status).toBe(201);
  });

  it("M7: concurrent retries with one Idempotency-Key create exactly one request", async () => {
    const wallet = await addVerifiedWallet(m);
    const send = () => m.agent.post("/v1/payment-requests").set("Origin", ORIGIN).set("Idempotency-Key", "burst").send({ walletId: wallet.id, asset: "USDC", amount: "50" });
    const results = await Promise.all(Array.from({ length: 8 }, send));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(7);
    expect(new Set(results.map((r) => r.body.request.id)).size).toBe(1);
    expect(await prisma.paymentRequest.count()).toBe(1);
  });

  it("M7: a malformed Idempotency-Key is rejected", async () => {
    const wallet = await addVerifiedWallet(m);
    for (const key of ["x".repeat(65), "has space"]) {
      const res = await m.agent.post("/v1/payment-requests").set("Origin", ORIGIN).set("Idempotency-Key", key).send({ walletId: wallet.id, asset: "USDC", amount: "50" });
      expect(res.status).toBe(400);
    }
  });

  it("M8: amount 0, negative, more than 7 decimals, too large or not a string is 400", async () => {
    const wallet = await addVerifiedWallet(m);
    for (const amount of ["0", "0.0000000", "-1", "1.00000001", "999999999999.9999999", "922337203685.4775808", "1e5", "ten", "", " 5", "5,00", 50, null]) {
      const res = await create(wallet.id, { amount });
      expect(res.status, String(amount)).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    }
    expect((await create(wallet.id, { amount: "0.0000001", asset: "XLM" })).status).toBe(201);
    expect(await prisma.paymentRequest.count()).toBe(1);
  });

  it("M9: an unsupported asset is 400 with the allowed list", async () => {
    const wallet = await addVerifiedWallet(m);
    for (const asset of ["BTC", "usdc", "", `USDC:${FAKE_ISSUER}`]) {
      const res = await create(wallet.id, { asset });
      expect(res.status, asset).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
      expect(res.body.error.message).toContain("USDC, XLM");
      expect(res.body.error.details).toEqual([{ path: "asset", message: expect.stringContaining("USDC, XLM") }]);
    }
  });

  it("rejects unknown fields, over-long text, oversized metadata, bad wallet ids and malformed JSON", async () => {
    const wallet = await addVerifiedWallet(m);
    expect((await create(wallet.id, { status: "PAID" })).status).toBe(400);
    expect((await create(wallet.id, { memo: "PLAAAAAAAA" })).status).toBe(400);
    expect((await create(wallet.id, { description: "x".repeat(201) })).status).toBe(400);
    expect((await create(wallet.id, { customerRef: "x".repeat(65) })).status).toBe(400);
    expect((await create(wallet.id, { metadata: { blob: "x".repeat(5000) } })).status).toBe(400);
    expect((await create(wallet.id, { metadata: "text" })).status).toBe(400);
    expect((await create("no-such-wallet")).status).toBe(404);
    expect((await create("../../etc")).status).toBe(400);
    const malformed = await m.agent.post("/v1/payment-requests").set("Origin", ORIGIN).set("Content-Type", "application/json").send('{"walletId": ');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("VALIDATION_FAILED");
    const huge = await create(wallet.id, { metadata: { blob: "x".repeat(60_000) } });
    expect(huge.status).toBe(413);
    expect(huge.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(await prisma.paymentRequest.count()).toBe(0);
  });
});
