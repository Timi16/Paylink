import { FeeBumpTransaction, rpc, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import { decodeEvent, ledgerOfCursor, type RawEvent } from "../decode";
import type { MemoType, NormalizedPayment } from "../types";
import type { ChainTip, FetchParams, FetchResult, StellarSource } from "./StellarSource";

const TRANSFER = xdr.ScVal.scvSymbol("transfer").toXDR("base64");
const MINT = xdr.ScVal.scvSymbol("mint").toXDR("base64");

/**
 * Topic-only filter: every `transfer` / `mint` on the network, from any contract. We do NOT
 * filter by the USDC/XLM contract ids because a payment in the wrong asset or from a
 * counterfeit issuer must still be seen to be reported as WRONG_ASSET / WRONG_ISSUER.
 * decodeEvent() then accepts only genuine Stellar Asset Contract events.
 */
const FILTERS: rpc.Api.EventFilter[] = [
  {
    type: "contract",
    topics: [
      [TRANSFER, "*", "*", "*"],
      [MINT, "*", "*"],
      [MINT, "*", "*", "*"],
    ],
  },
];

/** About 40 minutes of ledgers: how long a missing transaction blocks its batch before we move on. */
const TX_LOOKUP_RETRY_LEDGERS = 500;

interface TxInfo {
  outerHash: string;
  innerHash: string | null;
  memoType: MemoType;
  memoRaw: string | null;
}

export interface RpcEventSourceOptions {
  rpcUrl: string;
  networkPassphrase: string;
  logger: Logger;
  timeoutMs?: number;
}

function epochToDate(value: string | number | undefined): Date | null {
  if (value === undefined) return null;
  const seconds = Number.parseInt(String(value), 10);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

export class RpcEventSource implements StellarSource {
  private readonly server: rpc.Server;
  private readonly txCache = new Map<string, TxInfo>();

  constructor(private readonly opts: RpcEventSourceOptions) {
    this.server = new rpc.Server(opts.rpcUrl, {
      timeout: opts.timeoutMs ?? 15_000,
      allowHttp: opts.rpcUrl.startsWith("http://"),
    });
  }

  async getTip(): Promise<ChainTip> {
    const [latest, health] = await Promise.all([
      this.server._getLatestLedger(),
      this.server.getHealth(),
    ]);
    return {
      ledger: latest.sequence,
      closedAt: epochToDate(latest.closeTime) ?? new Date(),
      oldestLedger: health.oldestLedger,
    };
  }

  async fetch(params: FetchParams): Promise<FetchResult> {
    const request: rpc.Api.GetEventsRequest = params.cursor
      ? { cursor: params.cursor, filters: FILTERS, limit: params.limit }
      : { startLedger: params.startLedger, filters: FILTERS, limit: params.limit };
    const res = await this.server._getEvents(request);
    const events = res.events as RawEvent[];
    const full = events.length >= params.limit;

    const payments: NormalizedPayment[] = [];
    for (const ev of events) {
      const payment = decodeEvent(ev, this.opts.networkPassphrase);
      if (!payment || !params.isWatched(payment.to)) continue;
      payments.push(await this.enrich(payment, res.latestLedger));
    }

    return {
      payments,
      cursor: res.cursor || events[events.length - 1]?.id || null,
      full,
      processedThrough: await this.processedThrough(res, events, full),
      latestLedger: res.latestLedger,
    };
  }

  /**
   * Works out the last ledger that is fully behind us.
   * - Full page: the last event's ledger may have more events, so only the one before it.
   * - Short page: RPC scanned to the end of its window; the returned cursor names the last
   *   ledger scanned (RPC caps how many ledgers one call scans, so it may trail the tip).
   */
  private async processedThrough(
    res: rpc.Api.RawGetEventsResponse,
    events: RawEvent[],
    full: boolean,
  ): Promise<FetchResult["processedThrough"]> {
    const last = events[events.length - 1];
    let ledger: number;
    if (full && last) {
      ledger = last.ledger - 1;
    } else {
      const scanned = res.cursor ? ledgerOfCursor(res.cursor) : null;
      ledger = Math.min(scanned ?? res.latestLedger, res.latestLedger);
    }
    if (ledger <= 0) return null;
    if (ledger === res.latestLedger) {
      return { ledger, closedAt: epochToDate(res.latestLedgerCloseTime) };
    }
    const sameLedger = events.find((e) => e.ledger === ledger);
    if (sameLedger) return { ledger, closedAt: new Date(sameLedger.ledgerClosedAt) };
    try {
      const page = await this.server._getLedgers({ startLedger: ledger, pagination: { limit: 1 } });
      return { ledger, closedAt: epochToDate(page.ledgers[0]?.ledgerCloseTime) };
    } catch (err) {
      this.opts.logger.debug({ err, ledger }, "rpc: could not read ledger close time");
      return { ledger, closedAt: null };
    }
  }

  /**
   * Adds what the event alone cannot tell us: the inner hash of a fee-bump transaction, and
   * the envelope memo when the event carries none (e.g. a contract wallet invoking the SAC
   * `transfer` directly: the memo is on the transaction, not in the event).
   */
  private async enrich(payment: NormalizedPayment, latestLedger: number): Promise<NormalizedPayment> {
    const info = await this.txInfo(payment.txHash);
    if (info === "missing") {
      // The event has no memo and its transaction cannot be read yet (a lagging node). Its
      // memo may be on the envelope, so recording it now could file a paid request under
      // NO_MEMO for good. Fail the batch and retry; only give up once the ledger is old
      // enough that the transaction is plainly not coming back.
      if (payment.memoType === "none" && latestLedger - payment.ledger < TX_LOOKUP_RETRY_LEDGERS) {
        throw new Error(`transaction ${payment.txHash} is not available from RPC yet`);
      }
      return payment;
    }
    if (!info) return payment;
    const enriched: NormalizedPayment = {
      ...payment,
      txHash: info.outerHash,
      innerTxHash: info.innerHash,
    };
    if (payment.memoType === "none" && info.memoType !== "none") {
      enriched.memoType = info.memoType;
      enriched.memoRaw = info.memoRaw;
    }
    return enriched;
  }

  /** "missing" = RPC does not have the transaction; null = it has it but it could not be parsed. */
  private async txInfo(hash: string): Promise<TxInfo | "missing" | null> {
    const cached = this.txCache.get(hash);
    if (cached) return cached;
    // Transient failures throw: the batch is retried rather than recorded with a wrong memo.
    const res = await this.server._getTransaction(hash);
    if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS || !res.envelopeXdr) return "missing";
    const info = this.parseEnvelope(hash, res.envelopeXdr);
    // Only hits are cached: a miss may just mean the transaction is not indexed yet.
    if (!info) return null;
    if (this.txCache.size >= 1000) {
      const oldest = this.txCache.keys().next().value;
      if (oldest !== undefined) this.txCache.delete(oldest);
    }
    this.txCache.set(hash, info);
    return info;
  }

  private parseEnvelope(eventHash: string, envelopeXdr: string): TxInfo | null {
    try {
      const parsed = TransactionBuilder.fromXDR(envelopeXdr, this.opts.networkPassphrase);
      const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
      const isFeeBump = parsed instanceof FeeBumpTransaction;
      const inner = isFeeBump ? parsed.innerTransaction : parsed;
      const memo = inner.memo;
      let memoType: MemoType = "none";
      let memoRaw: string | null = null;
      if (memo.type === "text" && memo.value != null) {
        memoType = "text";
        memoRaw =
          typeof memo.value === "string" ? memo.value : Buffer.from(memo.value).toString("utf8");
      } else if (memo.type === "id" && memo.value != null) {
        memoType = "id";
        memoRaw = String(memo.value);
      } else if ((memo.type === "hash" || memo.type === "return") && memo.value != null) {
        memoType = "hash";
        memoRaw =
          typeof memo.value === "string" ? memo.value : Buffer.from(memo.value).toString("hex");
      }
      return {
        outerHash: isFeeBump ? hex(parsed.hash()) : eventHash,
        innerHash: isFeeBump ? hex(inner.hash()) : null,
        memoType,
        memoRaw,
      };
    } catch (err) {
      this.opts.logger.warn({ err, txHash: eventHash }, "rpc: could not parse envelope");
      return null;
    }
  }
}
