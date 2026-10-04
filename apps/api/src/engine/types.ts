export type MemoType = "none" | "text" | "id" | "hash";

/** One asset movement into a wallet, in the shape the matcher understands. */
export interface NormalizedPayment {
  /** RPC event id, or "hz-<operation id>-<n>" when backfilled from Horizon. */
  eventId: string;
  txHash: string;
  /** Set for fee-bump transactions: the hash of the wrapped inner transaction. */
  innerTxHash: string | null;
  ledger: number;
  ledgerClosedAt: Date;
  from: string;
  /** Base G address (muxed destinations are already resolved). */
  to: string;
  toMuxedId: string | null;
  memoRaw: string | null;
  memoType: MemoType;
  assetCode: string;
  /** null = native XLM */
  assetIssuer: string | null;
  amountStroops: bigint;
  eventType: "transfer" | "mint";
  source: "rpc" | "horizon";
}
