import { Address, Asset, nativeToScVal, Networks, xdr } from "@stellar/stellar-sdk";
import type { RawEvent } from "../../src/engine/decode";

export type MuxedId = { text: string } | { id: bigint } | { hash: Uint8Array };

export interface EventSpec {
  kind?: "transfer" | "mint";
  from?: string;
  to: string;
  /** SEP-11 asset string: "native" or "CODE:ISSUER". */
  asset: string;
  amount: bigint;
  muxed?: MuxedId;
  /** Override the emitting contract (defaults to the asset's real SAC). */
  contractId?: string;
  ledger?: number;
  successful?: boolean;
  id?: string;
  txHash?: string;
}

const b64 = (v: xdr.ScVal) => v.toXDR("base64");
const sym = (s: string) => xdr.ScVal.scvSymbol(s);

export function sacId(asset: string): string {
  if (asset === "native") return Asset.native().contractId(Networks.TESTNET);
  const [code, issuer] = asset.split(":") as [string, string];
  return new Asset(code, issuer).contractId(Networks.TESTNET);
}

/** Builds a raw getEvents entry exactly as RPC returns it (CAP-67 shapes). */
export function rawEvent(spec: EventSpec): RawEvent {
  const kind = spec.kind ?? "transfer";
  const amount = nativeToScVal(spec.amount, { type: "i128" });
  let value = amount;
  if (spec.muxed) {
    const m = spec.muxed;
    const muxVal =
      "text" in m
        ? xdr.ScVal.scvString(m.text)
        : "id" in m
          ? nativeToScVal(m.id, { type: "u64" })
          : xdr.ScVal.scvBytes(Buffer.from(m.hash));
    value = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym("amount"), val: amount }),
      new xdr.ScMapEntry({ key: sym("to_muxed_id"), val: muxVal }),
    ]);
  }
  const addr = (a: string) => new Address(a).toScVal();
  const assetTopic = nativeToScVal(spec.asset, { type: "string" });
  const topic =
    kind === "transfer"
      ? [sym("transfer"), addr(spec.from ?? "GAE6HVGQRXFG5BVAAVZBKP44U6JMFHYVDRAVGADJFHBSVS6RX7PETWFV"), addr(spec.to), assetTopic]
      : [sym("mint"), addr(spec.to), assetTopic];
  const ledger = spec.ledger ?? 5_000_000;
  return {
    id: spec.id ?? `${(BigInt(ledger) << 32n).toString().padStart(19, "0")}-0000000000`,
    type: "contract",
    ledger,
    ledgerClosedAt: "2026-10-04T21:12:32Z",
    contractId: spec.contractId ?? sacId(spec.asset),
    txHash: spec.txHash ?? "5aa6658ece57ce25292adfab114ce5c90e6520f396bb3477b876afb259635c98",
    inSuccessfulContractCall: spec.successful ?? true,
    topic: topic.map(b64),
    value: b64(value),
  };
}
