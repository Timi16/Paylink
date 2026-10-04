import { Networks } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { decodeEvent, ledgerOfCursor, parseSep11Asset } from "../../src/engine/decode";
import { rawEvent, sacId } from "../helpers/events";
import { FAKE_ISSUER, USDC_ISSUER } from "../helpers/fakes";

const WALLET = "GAS2RJQFMPHEDEG4MLQGNRIVHCXFXG7IEVFC2RNPHG7WXRIZNZVDIUAC";
const USDC = `USDC:${USDC_ISSUER}`;
const decode = (spec: Parameters<typeof rawEvent>[0]) => decodeEvent(rawEvent(spec), Networks.TESTNET);

describe("decode", () => {
  it("P1: decodes a classic payment with a text memo", () => {
    const p = decode({ to: WALLET, asset: USDC, amount: 500_000_000n, muxed: { text: "PL7K2M9QXA" } });
    expect(p).toMatchObject({
      to: WALLET,
      assetCode: "USDC",
      assetIssuer: USDC_ISSUER,
      amountStroops: 500_000_000n,
      memoType: "text",
      memoRaw: "PL7K2M9QXA",
      eventType: "transfer",
      source: "rpc",
      ledger: 5_000_000,
    });
  });

  it("P2: a bare i128 value means no memo", () => {
    expect(decode({ to: WALLET, asset: "native", amount: 10n })).toMatchObject({
      memoType: "none",
      memoRaw: null,
      assetCode: "XLM",
      assetIssuer: null,
    });
  });

  it("P5: MEMO_ID arrives as u64 and MEMO_HASH as bytes", () => {
    expect(decode({ to: WALLET, asset: USDC, amount: 1n, muxed: { id: 8298298319n } })).toMatchObject({
      memoType: "id",
      memoRaw: "8298298319",
    });
    expect(decode({ to: WALLET, asset: USDC, amount: 1n, muxed: { hash: Buffer.alloc(32, 7) } })).toMatchObject({
      memoType: "hash",
      memoRaw: "07".repeat(32),
    });
  });

  it("P14: a path payment is the USDC transfer that reaches the wallet", () => {
    // The payer sent XLM; the wallet-side event is a USDC transfer for the amount received.
    const p = decode({ to: WALLET, asset: USDC, amount: 123_456_789n, muxed: { text: "PL7K2M9QXA" } });
    expect(p).toMatchObject({ assetCode: "USDC", amountStroops: 123_456_789n, memoType: "text" });
  });

  it("P15: a contract (C address) payer is decoded like any other", () => {
    const contract = "CAYPAQDKNWMHRATKU5DQ327VDHVRSIVK7UGVWT2A5SUZCUFTLUHXH2JA";
    expect(decode({ from: contract, to: WALLET, asset: USDC, amount: 5n })).toMatchObject({ from: contract, to: WALLET });
  });

  it("P16: an M-address payment carries the base G address and the mux id", () => {
    expect(decode({ to: WALLET, asset: USDC, amount: 5n, muxed: { id: 42n } })).toMatchObject({
      to: WALLET,
      toMuxedId: "42",
      memoType: "id",
    });
  });

  it("P17: a mint is a payment from the issuer", () => {
    expect(decode({ kind: "mint", to: WALLET, asset: USDC, amount: 9n, muxed: { text: "PL7K2M9QXA" } })).toMatchObject({
      eventType: "mint",
      from: USDC_ISSUER,
      memoRaw: "PL7K2M9QXA",
    });
  });

  it("P19: events from a failed call are ignored", () => {
    expect(decode({ to: WALLET, asset: USDC, amount: 5n, successful: false })).toBeNull();
  });

  it("P7: USDC from another issuer is decoded with that issuer (so it can be flagged)", () => {
    expect(decode({ to: WALLET, asset: `USDC:${FAKE_ISSUER}`, amount: 5n })).toMatchObject({
      assetCode: "USDC",
      assetIssuer: FAKE_ISSUER,
    });
  });

  it("rejects a forged transfer: a custom contract naming real USDC in the topic", () => {
    const forged = decode({ to: WALLET, asset: USDC, amount: 5n, contractId: sacId(`USDC:${FAKE_ISSUER}`) });
    expect(forged).toBeNull();
    expect(decode({ to: WALLET, asset: USDC, amount: 5n, contractId: sacId("native") })).toBeNull();
  });

  it("rejects zero, negative and absurd amounts, contract destinations and junk", () => {
    expect(decode({ to: WALLET, asset: USDC, amount: 0n })).toBeNull();
    expect(decode({ to: WALLET, asset: USDC, amount: -5n })).toBeNull();
    expect(decode({ to: WALLET, asset: USDC, amount: 2n ** 64n })).toBeNull();
    expect(decode({ to: "CAYPAQDKNWMHRATKU5DQ327VDHVRSIVK7UGVWT2A5SUZCUFTLUHXH2JA", asset: USDC, amount: 5n })).toBeNull();
    const ev = rawEvent({ to: WALLET, asset: USDC, amount: 5n });
    expect(decodeEvent({ ...ev, value: "not-xdr" }, Networks.TESTNET)).toBeNull();
    expect(decodeEvent({ ...ev, topic: ev.topic?.slice(0, 2) }, Networks.TESTNET)).toBeNull();
    expect(decodeEvent({ ...ev, type: "system" }, Networks.TESTNET)).toBeNull();
  });

  it("parses SEP-11 asset strings", () => {
    expect(parseSep11Asset("native")).toEqual({ code: "XLM", issuer: null });
    expect(parseSep11Asset(USDC)).toEqual({ code: "USDC", issuer: USDC_ISSUER });
    for (const bad of ["", "USDC", "USDC:nope", "US DC:" + USDC_ISSUER, `A:B:${USDC_ISSUER}`, `TOOLONGCODE123:${USDC_ISSUER}`]) {
      expect(parseSep11Asset(bad), bad).toBeNull();
    }
  });

  it("reads the ledger out of an RPC cursor", () => {
    expect(ledgerOfCursor("0021582176302661631-4294967295")).toBe(5024991);
    expect(ledgerOfCursor("0021582008798941184-0000000000")).toBe(5024953);
    expect(ledgerOfCursor("garbage")).toBeNull();
  });
});
