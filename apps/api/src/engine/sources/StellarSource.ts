import type { NormalizedPayment } from "../types";

export interface ChainTip {
  /** Latest closed ledger. */
  ledger: number;
  closedAt: Date;
  /** Oldest ledger the live source can still serve. */
  oldestLedger: number;
}

export interface FetchParams {
  /** Resume token from a previous page. Takes precedence over startLedger. */
  cursor?: string | null;
  /** First ledger to scan when there is no cursor. */
  startLedger: number;
  limit: number;
  /** Only payments to these addresses are enriched and returned. */
  isWatched: (address: string) => boolean;
}

export interface FetchResult {
  /** Payments to watched wallets, in ledger order. */
  payments: NormalizedPayment[];
  /** Token to continue from; null if the source gave none. */
  cursor: string | null;
  /** True when the page hit the limit, i.e. more events are waiting. */
  full: boolean;
  /**
   * The last ledger whose events have ALL been returned up to and including this page, with
   * its close time when known. Null when this page proves nothing new.
   */
  processedThrough: { ledger: number; closedAt: Date | null } | null;
  latestLedger: number;
}

/** Live event source. Production uses Stellar RPC; integration tests use a fake. */
export interface StellarSource {
  getTip(): Promise<ChainTip>;
  fetch(params: FetchParams): Promise<FetchResult>;
}

/** Historical source used when the cursor is older than the live source's retention. */
export interface BackfillSource {
  /** Payments into `address` in ledgers [fromLedger, toLedger], ascending, in pages. */
  payments(address: string, fromLedger: number, toLedger: number): AsyncIterable<NormalizedPayment[]>;
}
