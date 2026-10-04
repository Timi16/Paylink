import type { Logger } from "pino";
import { parseAmount } from "../../lib/amount";
import type { MemoType, NormalizedPayment } from "../types";
import type { BackfillSource } from "./StellarSource";

interface HorizonTx {
  hash?: string;
  successful?: boolean;
  memo?: string;
  memo_type?: string;
  memo_bytes?: string;
  ledger?: number;
  inner_transaction?: { hash?: string };
  fee_bump_transaction?: { hash?: string };
}

interface BalanceChange {
  type?: string;
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  destination_muxed_id?: string;
}

interface HorizonOp {
  id: string;
  paging_token: string;
  type: string;
  created_at: string;
  transaction_hash: string;
  transaction_successful?: boolean;
  transaction?: HorizonTx;
  from?: string;
  to?: string;
  to_muxed_id?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  // create_account
  funder?: string;
  account?: string;
  starting_balance?: string;
  // invoke_host_function
  asset_balance_changes?: BalanceChange[];
}

interface HorizonPage {
  _links?: { next?: { href?: string } };
  _embedded?: { records?: HorizonOp[] };
}

/** TOID of the first possible operation in a ledger: ledger << 32. */
function toidForLedger(ledger: number): string {
  return (BigInt(ledger) << 32n).toString();
}

function ledgerOfToid(toid: string): number {
  return Number.parseInt((BigInt(toid) >> 32n).toString(), 10);
}

function assetOf(o: { asset_type?: string; asset_code?: string; asset_issuer?: string }) {
  if (o.asset_type === "native") return { code: "XLM", issuer: null as string | null };
  if (o.asset_code && o.asset_issuer) return { code: o.asset_code, issuer: o.asset_issuer };
  return null;
}

function memoOf(tx: HorizonTx | undefined, muxedId: string | undefined) {
  // Mirrors CAP-67: a muxed destination's id wins over the transaction memo.
  if (muxedId) return { memoType: "id" as MemoType, memoRaw: muxedId, toMuxedId: muxedId };
  const type = tx?.memo_type;
  if (type === "text") return { memoType: "text" as MemoType, memoRaw: tx?.memo ?? "", toMuxedId: null };
  if (type === "id") return { memoType: "id" as MemoType, memoRaw: tx?.memo ?? "", toMuxedId: null };
  if (type === "hash" || type === "return") {
    return { memoType: "hash" as MemoType, memoRaw: tx?.memo ?? "", toMuxedId: null };
  }
  return { memoType: "none" as MemoType, memoRaw: null, toMuxedId: null };
}

/** Horizon /accounts/{id}/payments record(s) -> payments into `address`. */
export function decodeHorizonOp(op: HorizonOp, address: string): NormalizedPayment[] {
  if (op.transaction_successful === false || op.transaction?.successful === false) return [];
  const ledger = ledgerOfToid(op.paging_token);
  const closedAt = new Date(op.created_at);
  if (Number.isNaN(closedAt.getTime())) return [];
  const tx = op.transaction;
  // For fee-bumps Horizon reports the outer hash under fee_bump_transaction.
  const innerHash = tx?.inner_transaction?.hash ?? null;
  const outerHash = tx?.fee_bump_transaction?.hash ?? tx?.hash ?? op.transaction_hash;

  const moves: { from: string; amount: string; asset: ReturnType<typeof assetOf>; muxedId?: string; eventType: "transfer" | "mint" }[] = [];
  switch (op.type) {
    case "payment":
    case "path_payment_strict_receive":
    case "path_payment_strict_send":
      if (op.to === address && op.from && op.amount) {
        moves.push({ from: op.from, amount: op.amount, asset: assetOf(op), muxedId: op.to_muxed_id, eventType: "transfer" });
      }
      break;
    case "create_account":
      if (op.account === address && op.funder && op.starting_balance) {
        moves.push({ from: op.funder, amount: op.starting_balance, asset: { code: "XLM", issuer: null }, eventType: "transfer" });
      }
      break;
    case "invoke_host_function":
      for (const change of op.asset_balance_changes ?? []) {
        if (change.to !== address || !change.amount) continue;
        if (change.type !== "transfer" && change.type !== "mint") continue;
        const asset = assetOf(change);
        const from = change.type === "mint" ? asset?.issuer : change.from;
        if (!from) continue;
        moves.push({ from, amount: change.amount, asset, muxedId: change.destination_muxed_id, eventType: change.type });
      }
      break;
    default:
      // account_merge and claimable-balance claims are not listed with amounts here;
      // they are picked up live from RPC events, not from backfill.
      break;
  }

  const out: NormalizedPayment[] = [];
  moves.forEach((move, index) => {
    const stroops = parseAmount(move.amount);
    if (!move.asset || stroops === null || stroops <= 0n) return;
    const memo = memoOf(tx, move.muxedId);
    out.push({
      eventId: `hz-${op.id}-${index}`,
      txHash: outerHash,
      innerTxHash: innerHash && innerHash !== outerHash ? innerHash : null,
      ledger,
      ledgerClosedAt: closedAt,
      from: move.from,
      to: address,
      toMuxedId: memo.toMuxedId,
      memoRaw: memo.memoRaw,
      memoType: memo.memoType,
      assetCode: move.asset.code,
      assetIssuer: move.asset.issuer,
      amountStroops: stroops,
      eventType: move.eventType,
      source: "horizon",
    });
  });
  return out;
}

export interface HorizonBackfillOptions {
  horizonUrl: string;
  logger: Logger;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Reads payment history from Horizon when the cursor has fallen out of RPC retention. */
export class HorizonBackfillSource implements BackfillSource {
  constructor(private readonly opts: HorizonBackfillOptions) {}

  async *payments(
    address: string,
    fromLedger: number,
    toLedger: number,
  ): AsyncIterable<NormalizedPayment[]> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const base = this.opts.horizonUrl.replace(/\/$/, "");
    let url: string | null =
      `${base}/accounts/${address}/payments?order=asc&limit=200&join=transactions` +
      `&cursor=${toidForLedger(fromLedger)}`;
    while (url) {
      const res: Response = await doFetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
      if (res.status === 404) return; // account does not exist: nothing to backfill
      if (!res.ok) throw new Error(`Horizon backfill failed: HTTP ${res.status}`);
      const page = (await res.json()) as HorizonPage;
      const records = page._embedded?.records ?? [];
      if (records.length === 0) return;
      const batch: NormalizedPayment[] = [];
      let pastEnd = false;
      for (const op of records) {
        if (ledgerOfToid(op.paging_token) > toLedger) {
          pastEnd = true;
          break;
        }
        batch.push(...decodeHorizonOp(op, address));
      }
      if (batch.length > 0) yield batch;
      if (pastEnd || records.length < 200) return;
      url = page._links?.next?.href ?? null;
    }
  }
}
