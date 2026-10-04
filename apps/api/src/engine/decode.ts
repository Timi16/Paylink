import { Asset, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import { MAX_STROOPS } from "../lib/amount";
import type { MemoType, NormalizedPayment } from "./types";

/** The subset of an RPC getEvents entry that decoding needs (raw, base64 XDR). */
export interface RawEvent {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  txHash: string;
  inSuccessfulContractCall: boolean;
  topic?: string[];
  value: string;
}

export interface ParsedAsset {
  code: string;
  issuer: string | null;
}

const ASSET_CODE = /^[A-Za-z0-9]{1,12}$/;

/** Parses the SEP-11 asset string in the last topic: "native" or "CODE:ISSUER". */
export function parseSep11Asset(value: string): ParsedAsset | null {
  if (value === "native") return { code: "XLM", issuer: null };
  const parts = value.split(":");
  const [code, issuer] = parts;
  if (parts.length !== 2 || !code || !issuer) return null;
  if (!ASSET_CODE.test(code) || !StrKey.isValidEd25519PublicKey(issuer)) return null;
  return { code, issuer };
}

const sacIdCache = new Map<string, string>();

/** Contract id of the Stellar Asset Contract for an asset on this network (deterministic). */
export function sacContractId(asset: ParsedAsset, networkPassphrase: string): string {
  const key = `${networkPassphrase}|${asset.code}|${asset.issuer ?? ""}`;
  let id = sacIdCache.get(key);
  if (!id) {
    const sdkAsset = asset.issuer === null ? Asset.native() : new Asset(asset.code, asset.issuer);
    id = sdkAsset.contractId(networkPassphrase);
    if (sacIdCache.size > 5000) sacIdCache.clear();
    sacIdCache.set(key, id);
  }
  return id;
}

function native(val: xdr.ScVal): unknown {
  try {
    return scValToNative(val) as unknown;
  } catch {
    return undefined;
  }
}

function bytesToText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return null;
}

interface DecodedValue {
  amount: bigint;
  memoType: MemoType;
  memoRaw: string | null;
  toMuxedId: string | null;
}

/**
 * CAP-67 event data: either a bare i128 amount, or a map { amount, to_muxed_id } where
 * to_muxed_id carries the transaction memo or the destination's mux id:
 *   string -> MEMO_TEXT, u64 -> MEMO_ID / M-address id, bytes -> MEMO_HASH / MEMO_RETURN.
 * Verified against testnet (protocol 23+) on 2026-10-04.
 */
function decodeValue(value: xdr.ScVal): DecodedValue | null {
  const type = (value as { type?: string }).type;
  if (type === "scvI128") {
    const amount = native(value);
    return typeof amount === "bigint"
      ? { amount, memoType: "none", memoRaw: null, toMuxedId: null }
      : null;
  }
  if (type !== "scvMap") return null;
  const entries = (value as { map?: { key: xdr.ScVal; val: xdr.ScVal }[] | null }).map ?? [];
  let amount: bigint | null = null;
  let memoType: MemoType = "none";
  let memoRaw: string | null = null;
  let toMuxedId: string | null = null;
  for (const entry of entries) {
    const key = native(entry.key);
    if (key === "amount") {
      const v = native(entry.val);
      if (typeof v === "bigint") amount = v;
    } else if (key === "to_muxed_id") {
      const valType = (entry.val as { type?: string }).type;
      const v = native(entry.val);
      if (valType === "scvU64" && typeof v === "bigint") {
        memoType = "id";
        memoRaw = v.toString();
        toMuxedId = v.toString();
      } else if (valType === "scvString") {
        memoType = "text";
        memoRaw = bytesToText(v);
      } else if (valType === "scvBytes" && v instanceof Uint8Array) {
        memoType = "hash";
        memoRaw = Buffer.from(v).toString("hex");
      }
    }
  }
  return amount === null ? null : { amount, memoType, memoRaw, toMuxedId };
}

/**
 * Event -> NormalizedPayment, or null when the event is not a genuine asset movement into
 * a classic (G) account.
 *
 * Security: any contract can emit an event shaped like `transfer`. An event only counts if
 * its contract id is exactly the Stellar Asset Contract derived from the asset named in the
 * topic; otherwise a custom contract could forge "USDC" payments.
 */
export function decodeEvent(ev: RawEvent, networkPassphrase: string): NormalizedPayment | null {
  if (ev.type !== "contract" || !ev.inSuccessfulContractCall) return null;
  const rawTopics = ev.topic ?? [];
  if (rawTopics.length < 3 || rawTopics.length > 4) return null;

  let topics: unknown[];
  let value: xdr.ScVal;
  try {
    topics = rawTopics.map((t) => native(xdr.ScVal.fromXDR(t, "base64")));
    value = xdr.ScVal.fromXDR(ev.value, "base64");
  } catch {
    return null;
  }

  const name = topics[0];
  const assetString = topics[topics.length - 1];
  const to = topics[topics.length - 2];
  let from: unknown;
  if (name === "transfer" && topics.length === 4) {
    from = topics[1];
  } else if (name === "mint") {
    // ["mint", to, asset] since protocol 23; ["mint", admin, to, asset] before it.
    from = null;
  } else {
    return null;
  }
  if (typeof assetString !== "string" || typeof to !== "string") return null;
  if (!StrKey.isValidEd25519PublicKey(to)) return null; // wallets are G accounts only

  const asset = parseSep11Asset(assetString);
  if (!asset) return null;
  if (ev.contractId !== sacContractId(asset, networkPassphrase)) return null;

  const decoded = decodeValue(value);
  if (!decoded || decoded.amount <= 0n || decoded.amount > MAX_STROOPS) return null;

  // A mint is a payment from the issuer.
  const fromAddress = name === "mint" ? asset.issuer : typeof from === "string" ? from : null;
  if (!fromAddress) return null;

  const closedAt = new Date(ev.ledgerClosedAt);
  if (Number.isNaN(closedAt.getTime())) return null;

  return {
    eventId: ev.id,
    txHash: ev.txHash,
    innerTxHash: null,
    ledger: ev.ledger,
    ledgerClosedAt: closedAt,
    from: fromAddress,
    to,
    toMuxedId: decoded.toMuxedId,
    memoRaw: decoded.memoRaw,
    memoType: decoded.memoType,
    assetCode: asset.code,
    assetIssuer: asset.issuer,
    amountStroops: decoded.amount,
    eventType: name === "mint" ? "mint" : "transfer",
    source: "rpc",
  };
}

/** Ledger sequence encoded in an RPC event id / cursor ("<TOID>-<index>"; TOID = ledger << 32 | …). */
export function ledgerOfCursor(cursor: string): number | null {
  const toid = cursor.split("-")[0];
  if (!toid || !/^\d{1,20}$/.test(toid)) return null;
  const ledger = BigInt(toid) >> 32n;
  return ledger > 0n && ledger < 2n ** 31n ? Number.parseInt(ledger.toString(), 10) : null;
}
