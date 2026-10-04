import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Account, Asset, Keypair, Memo, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { EnvSchema, loadEnv } from "../../src/config/env";
import { decodeHorizonOp } from "../../src/engine/sources/horizonBackfill";
import { RpcEventSource } from "../../src/engine/sources/rpcEventSource";
import { LoginThrottle } from "../../src/modules/auth/service";
import { sep7Uri } from "../../src/modules/public/service";
import { refundOwed } from "../../src/modules/requests/serialize";
import { ALLOWED, canTransition } from "../../src/modules/transitions";
import { checkCanReceive } from "../../src/modules/wallets/capability";
import { decodeSignature, verifyWalletSignature } from "../../src/modules/wallets/signature";
import { assertWalletAddress } from "../../src/modules/wallets/service";
import { rawEvent } from "../helpers/events";
import { usdcTrustline, USDC_ISSUER } from "../helpers/fakes";
import { silentLogger } from "../helpers/harness";

const SEP53_VECTOR = {
  address: "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR", // seed = 32 x 0x01
  message: "PayLink wallet verification",
  signature: "Gq3y93HA8Pjs9EbYKux4TRgCqVtRFWBxxjwseLyCcj66m6l8lFiPAq4XYfRv+FA0TqjF99MZqa3rCv99aEslCA==",
};

const validEnv = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  HORIZON_URL: "https://horizon-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  USDC_ISSUER,
  WEB_ORIGIN: "https://paylink.example",
  SESSION_SECRET: "ab".repeat(32),
};

describe("config/env", () => {
  it("accepts a valid testnet configuration and applies defaults", () => {
    expect(loadEnv(validEnv)).toMatchObject({ PORT: 4100, NODE_ENV: "development", LOG_LEVEL: "info" });
  });

  it("refuses to boot on any network but testnet", () => {
    expect(() => loadEnv({ ...validEnv, NETWORK_PASSPHRASE: Networks.PUBLIC })).toThrow(/testnet passphrase/);
  });

  it("rejects a short session secret, a bad issuer, a web origin with a path, and missing variables", () => {
    expect(() => loadEnv({ ...validEnv, SESSION_SECRET: "abcd" })).toThrow(/SESSION_SECRET/);
    expect(() => loadEnv({ ...validEnv, USDC_ISSUER: "GABC" })).toThrow(/USDC_ISSUER/);
    expect(() => loadEnv({ ...validEnv, WEB_ORIGIN: "https://paylink.example/app/" })).toThrow(/WEB_ORIGIN/);
    expect(() => loadEnv({ ...validEnv, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => loadEnv({ ...validEnv, DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it(".env.example lists every variable in env.ts and nothing else", () => {
    const example = readFileSync(resolve(__dirname, "../../../../.env.example"), "utf8");
    const listed = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]).sort();
    expect(listed).toEqual(Object.keys(EnvSchema.shape).sort());
  });
});

describe("transitions table", () => {
  it("PAID, OVERPAID, CANCELLED and NETWORK_RESET are final", () => {
    for (const s of ["PAID", "OVERPAID", "CANCELLED", "NETWORK_RESET"] as const) expect(ALLOWED[s]).toEqual([]);
  });

  it("allows only the documented moves", () => {
    expect(canTransition("PENDING", "OVERPAID")).toBe(true);
    expect(canTransition("PENDING", "CANCELLED")).toBe(true);
    expect(canTransition("UNDERPAID", "CANCELLED")).toBe(false);
    expect(canTransition("UNDERPAID", "UNDERPAID")).toBe(false);
    expect(canTransition("EXPIRED", "PAID")).toBe(true);
    expect(canTransition("EXPIRED", "PENDING")).toBe(false);
    expect(canTransition("PAID", "EXPIRED")).toBe(false);
  });

  it("T3: refund flag is set for overpayments and for closed requests that received money", () => {
    const amountStroops = 10n;
    expect(refundOwed({ status: "OVERPAID", receivedStroops: 11n, amountStroops })).toBe(true);
    expect(refundOwed({ status: "EXPIRED", receivedStroops: 5n, amountStroops })).toBe(true);
    expect(refundOwed({ status: "EXPIRED", receivedStroops: 0n, amountStroops })).toBe(false);
    expect(refundOwed({ status: "PAID", receivedStroops: 10n, amountStroops })).toBe(false);
    expect(refundOwed({ status: "UNDERPAID", receivedStroops: 5n, amountStroops })).toBe(false);
    // Accepted late payments that add up to more than was asked: PAID, but the excess is owed back.
    expect(refundOwed({ status: "PAID", receivedStroops: 12n, amountStroops })).toBe(true);
    // A payment that was not applied (duplicate, late, after cancel…) always means a refund.
    expect(refundOwed({ status: "PAID", receivedStroops: 10n, amountStroops }, true)).toBe(true);
    expect(refundOwed({ status: "CANCELLED", receivedStroops: 0n, amountStroops }, true)).toBe(true);
  });
});

describe("wallet signature (SEP-53)", () => {
  it("verifies the recorded test vector, as base64 and as hex", () => {
    const { address, message, signature } = SEP53_VECTOR;
    expect(verifyWalletSignature(address, message, signature)).toBe(true);
    const hex = Buffer.from(signature, "base64").toString("hex");
    expect(verifyWalletSignature(address, message, hex)).toBe(true);
  });

  it("rejects a different message, a different signer and junk", () => {
    const { address, message, signature } = SEP53_VECTOR;
    expect(verifyWalletSignature(address, message + "!", signature)).toBe(false);
    expect(verifyWalletSignature(Keypair.random().publicKey(), message, signature)).toBe(false);
    // A pre-SEP-53 wallet signs the bare message: accepted, but only for the exact message.
    const raw = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).sign(Buffer.from(message));
    expect(verifyWalletSignature(address, message, Buffer.from(raw).toString("base64"))).toBe(true);
    expect(verifyWalletSignature(address, message + "!", Buffer.from(raw).toString("base64"))).toBe(false);
    expect(verifyWalletSignature(address, message, "not a signature")).toBe(false);
    expect(decodeSignature("AAAA")).toBeNull();
  });
});

describe("wallet address rules", () => {
  it("M1: refuses secrets, muxed and invalid addresses without echoing them", () => {
    const kp = Keypair.random();
    expect(() => assertWalletAddress(kp.publicKey())).not.toThrow();
    try {
      assertWalletAddress(kp.secret());
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: "SECRET_KEY_REJECTED" });
      expect(JSON.stringify(err) + String((err as Error).message)).not.toContain(kp.secret());
    }
    expect(() => assertWalletAddress("MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK")).toThrow(/Muxed/);
    expect(() => assertWalletAddress("GABC")).toThrow(/valid Stellar/);
  });
});

describe("can the wallet receive?", () => {
  const usdc = { code: "USDC", issuer: USDC_ISSUER };
  it("M2: a missing account can receive nothing", () => {
    expect(checkCanReceive({ accountExists: false, trustlines: [] }, { code: "XLM", issuer: null }, 1n)).toEqual({ ok: false, reason: "ACCOUNT_NOT_FOUND" });
  });
  it("M3: no (or unauthorised) trustline", () => {
    expect(checkCanReceive({ accountExists: true, trustlines: [] }, usdc, 1n)).toEqual({ ok: false, reason: "NO_TRUSTLINE" });
    expect(checkCanReceive({ accountExists: true, trustlines: [usdcTrustline({ authorized: false })] }, usdc, 1n)).toEqual({ ok: false, reason: "NO_TRUSTLINE" });
    expect(checkCanReceive({ accountExists: true, trustlines: [usdcTrustline({ issuer: "GAGVZMODPYFTULIVSY3RGFADIC5LF4LLSN37N4MFWGNZ57TYBXL2LQQX" })] }, usdc, 1n)).toEqual({ ok: false, reason: "NO_TRUSTLINE" });
    expect(checkCanReceive({ accountExists: true, trustlines: [] }, { code: "XLM", issuer: null }, 1n)).toEqual({ ok: true });
  });
  it("M4: headroom is limit - balance - buying liabilities, to the stroop", () => {
    const line = usdcTrustline({ limit: "100.0000000", balance: "40.0000000", buyingLiabilities: "10.0000000" });
    const wallet = { accountExists: true, trustlines: [line] };
    expect(checkCanReceive(wallet, usdc, 500_000_000n)).toEqual({ ok: true });
    expect(checkCanReceive(wallet, usdc, 500_000_001n)).toEqual({ ok: false, reason: "TRUSTLINE_LIMIT_TOO_LOW" });
  });
});

describe("sep7", () => {
  it("builds a pay URI with memo and asset; XLM has no asset params", () => {
    const base = { walletAddress: "GAS2RJQFMPHEDEG4MLQGNRIVHCXFXG7IEVFC2RNPHG7WXRIZNZVDIUAC", memo: "PL7K2M9QXA", amountStroops: 500_000_000n };
    const usdc = sep7Uri({ ...base, assetCode: "USDC", assetIssuer: USDC_ISSUER });
    expect(usdc).toBe(
      "web+stellar:pay?destination=GAS2RJQFMPHEDEG4MLQGNRIVHCXFXG7IEVFC2RNPHG7WXRIZNZVDIUAC&amount=50.0000000&asset_code=USDC" +
        `&asset_issuer=${USDC_ISSUER}&memo=PL7K2M9QXA&memo_type=MEMO_TEXT&network_passphrase=Test%20SDF%20Network%20%3B%20September%202015`,
    );
    expect(sep7Uri({ ...base, assetCode: "XLM", assetIssuer: null })).not.toContain("asset_code");
  });
});

describe("login throttle", () => {
  it("locks an account with a growing delay from the 3rd failure and clears on success", () => {
    const t = new LoginThrottle();
    t.recordFailure("a@b.c");
    t.recordFailure("a@b.c");
    expect(() => t.assertAllowed("a@b.c")).not.toThrow();
    t.recordFailure("a@b.c");
    expect(() => t.assertAllowed("a@b.c")).toThrow(/Too many failed attempts/);
    expect(() => t.assertAllowed("other@b.c")).not.toThrow();
    t.recordSuccess("a@b.c");
    expect(() => t.assertAllowed("a@b.c")).not.toThrow();
  });
});

describe("horizon backfill decoding", () => {
  const WALLET = "GAS2RJQFMPHEDEG4MLQGNRIVHCXFXG7IEVFC2RNPHG7WXRIZNZVDIUAC";
  const op = {
    id: "21582008798941185",
    paging_token: "21582008798941185",
    type: "payment",
    created_at: "2026-10-04T21:12:32Z",
    transaction_hash: "aa".repeat(32),
    transaction_successful: true,
    from: "GAE6HVGQRXFG5BVAAVZBKP44U6JMFHYVDRAVGADJFHBSVS6RX7PETWFV",
    to: WALLET,
    amount: "50.0000000",
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: USDC_ISSUER,
    transaction: { hash: "aa".repeat(32), successful: true, memo_type: "text", memo: "PL7K2M9QXA" },
  };

  it("decodes a payment with its memo, ledger and amount", () => {
    expect(decodeHorizonOp(op, WALLET)).toEqual([
      expect.objectContaining({
        eventId: "hz-21582008798941185-0",
        ledger: 5024953,
        amountStroops: 500_000_000n,
        memoType: "text",
        memoRaw: "PL7K2M9QXA",
        source: "horizon",
        assetIssuer: USDC_ISSUER,
      }),
    ]);
  });

  it("P16: a muxed destination wins over the memo; P19: failed transactions are skipped", () => {
    expect(decodeHorizonOp({ ...op, to_muxed_id: "42" }, WALLET)[0]).toMatchObject({ memoType: "id", toMuxedId: "42" });
    expect(decodeHorizonOp({ ...op, transaction_successful: false }, WALLET)).toEqual([]);
    expect(decodeHorizonOp({ ...op, to: "GAE6HVGQRXFG5BVAAVZBKP44U6JMFHYVDRAVGADJFHBSVS6RX7PETWFV" }, WALLET)).toEqual([]);
  });

  it("P20: fee-bump transactions keep both hashes", () => {
    const tx = { ...op.transaction, hash: "bb".repeat(32), fee_bump_transaction: { hash: "bb".repeat(32) }, inner_transaction: { hash: "cc".repeat(32) } };
    expect(decodeHorizonOp({ ...op, transaction: tx }, WALLET)[0]).toMatchObject({ txHash: "bb".repeat(32), innerTxHash: "cc".repeat(32) });
  });
});

describe("RpcEventSource", () => {
  const WALLET = "GAS2RJQFMPHEDEG4MLQGNRIVHCXFXG7IEVFC2RNPHG7WXRIZNZVDIUAC";
  const USDC = `USDC:${USDC_ISSUER}`;
  const kp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));

  function envelope(opts: { memo?: string; feeBump?: boolean }) {
    const builder = new TransactionBuilder(new Account(kp.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: WALLET, asset: Asset.native(), amount: "1" }))
      .setTimeout(0);
    if (opts.memo) builder.addMemo(Memo.text(opts.memo));
    const tx = builder.build();
    tx.sign(kp);
    const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
    if (!opts.feeBump) return { xdr: tx.toXDR(), outer: hex(tx.hash()), inner: null as string | null };
    const fb = TransactionBuilder.buildFeeBumpTransaction(kp, "200", tx, Networks.TESTNET);
    return { xdr: fb.toXDR(), outer: hex(fb.hash()), inner: hex(tx.hash()) };
  }

  function sourceWith(events: ReturnType<typeof rawEvent>[], txs: Record<string, string>, extra: Record<string, unknown> = {}) {
    const source = new RpcEventSource({ rpcUrl: "http://127.0.0.1:1", networkPassphrase: Networks.TESTNET, logger: silentLogger });
    const calls = { getTransaction: 0 };
    (source as unknown as { server: unknown }).server = {
      _getEvents: async () => ({ events, cursor: "0021474840625152000-4294967295", latestLedger: 5_000_001, latestLedgerCloseTime: "1791148537", oldestLedger: 1, oldestLedgerCloseTime: "1", ...extra }),
      _getTransaction: async (hash: string) => {
        calls.getTransaction++;
        return txs[hash] ? { status: "SUCCESS", envelopeXdr: txs[hash] } : { status: "NOT_FOUND" };
      },
      _getLedgers: async () => ({ ledgers: [{ ledgerCloseTime: "1791148000" }] }),
    };
    return { source, calls };
  }
  const all = () => true;

  it("P20: a fee-bump transaction stores the outer and the inner hash", async () => {
    const env = envelope({ memo: "PL7K2M9QXA", feeBump: true });
    const ev = rawEvent({ to: WALLET, asset: USDC, amount: 5n, muxed: { text: "PL7K2M9QXA" }, txHash: env.inner as string });
    const { source } = sourceWith([ev], { [env.inner as string]: env.xdr });
    const res = await source.fetch({ startLedger: 1, limit: 200, isWatched: all });
    expect(res.payments[0]).toMatchObject({ txHash: env.outer, innerTxHash: env.inner, memoRaw: "PL7K2M9QXA" });
  });

  it("P15: a contract-wallet transfer has no memo in the event, so the transaction memo is used", async () => {
    const env = envelope({ memo: "PL7K2M9QXA" });
    const ev = rawEvent({ from: "CAYPAQDKNWMHRATKU5DQ327VDHVRSIVK7UGVWT2A5SUZCUFTLUHXH2JA", to: WALLET, asset: USDC, amount: 5n, txHash: env.outer });
    const { source } = sourceWith([ev], { [env.outer]: env.xdr });
    const res = await source.fetch({ startLedger: 1, limit: 200, isWatched: all });
    expect(res.payments[0]).toMatchObject({ memoType: "text", memoRaw: "PL7K2M9QXA", innerTxHash: null, txHash: env.outer });
  });

  it("only looks up transactions for watched wallets, caches hits but not misses, and survives a missing transaction", async () => {
    const env = envelope({});
    const mine = rawEvent({ to: WALLET, asset: USDC, amount: 5n, txHash: env.outer });
    const other = rawEvent({ to: Keypair.random().publicKey(), asset: USDC, amount: 5n, txHash: "ff".repeat(32) });
    // A memo-less event whose transaction RPC no longer has, from a ledger long past.
    const gone = rawEvent({ to: WALLET, asset: "native", amount: 7n, txHash: "ee".repeat(32), ledger: 4_000_000, id: "0017179869184000000-0000000000" });
    const { source, calls } = sourceWith([mine, other, gone], { [env.outer]: env.xdr });
    const res = await source.fetch({ startLedger: 1, limit: 200, isWatched: (a) => a === WALLET });
    expect(res.payments).toHaveLength(2);
    expect(res.payments[1]).toMatchObject({ memoType: "none", amountStroops: 7n });
    await source.fetch({ startLedger: 1, limit: 200, isWatched: (a) => a === WALLET });
    // Second pass: the found transaction is served from the cache; the missing one is looked
    // up again (a miss is never cached, it may just not be indexed yet).
    expect(calls.getTransaction).toBe(3);
  });

  it("P15: a recent memo-less event whose transaction is not readable yet fails the batch instead of becoming NO_MEMO", async () => {
    const pending = rawEvent({ to: WALLET, asset: USDC, amount: 5n, txHash: "dd".repeat(32) }); // ledger 5,000,000; tip 5,000,001
    const { source } = sourceWith([pending], {});
    await expect(source.fetch({ startLedger: 1, limit: 200, isWatched: all })).rejects.toThrow(/not available from RPC yet/);
    // With its memo already in the event there is nothing to wait for.
    const withMemo = rawEvent({ to: WALLET, asset: USDC, amount: 5n, txHash: "dd".repeat(32), muxed: { text: "PL7K2M9QXA" } });
    const res = await sourceWith([withMemo], {}).source.fetch({ startLedger: 1, limit: 200, isWatched: all });
    expect(res.payments[0]).toMatchObject({ memoRaw: "PL7K2M9QXA", innerTxHash: null });
  });

  it("T5: reports the last fully processed ledger conservatively", async () => {
    const e1 = rawEvent({ to: WALLET, asset: USDC, amount: 5n, ledger: 4_999_998, id: "a" });
    const e2 = rawEvent({ to: WALLET, asset: USDC, amount: 5n, ledger: 5_000_000, id: "b" });
    // Full page: the last event's ledger may have more events, so only the one before counts.
    const full = await sourceWith([e1, e2], {}).source.fetch({ startLedger: 1, limit: 2, isWatched: () => false });
    expect(full).toMatchObject({ full: true, processedThrough: { ledger: 4_999_999 } });
    // Short page: everything up to the ledger named by the cursor (capped at the tip).
    const short = await sourceWith([e1], {}).source.fetch({ startLedger: 1, limit: 200, isWatched: () => false });
    expect(short.full).toBe(false);
    expect(short.processedThrough?.ledger).toBe(5_000_000);
    const atTip = await sourceWith([], {}, { cursor: "0021474844920119295-4294967295" }).source.fetch({ startLedger: 1, limit: 200, isWatched: () => false });
    expect(atTip.processedThrough).toEqual({ ledger: 5_000_001, closedAt: new Date(1791148537 * 1000) });
  });
});
