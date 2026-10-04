import type { Cursor, PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import type { Tx } from "../db/prisma";
import type { Alerter } from "./alerter";
import { ledgerOfCursor } from "./decode";
import { processPayment } from "./matcher";
import { handleNetworkReset, isNetworkReset } from "./networkReset";
import type { BackfillSource, ChainTip, StellarSource } from "./sources/StellarSource";
import type { NormalizedPayment } from "./types";
import type { WatchedWallets } from "./watchedWallets";

export { CURSOR_NAME } from "./cursorName";
import { CURSOR_NAME } from "./cursorName";
export const PAGE_LIMIT = 200;
/** Ledgers of headroom above RPC's oldest ledger when handing over from Horizon to RPC. */
const BACKFILL_MARGIN = 20;
const TX_OPTIONS = { timeout: 60_000, maxWait: 15_000 };

export interface IngestionDeps {
  prisma: PrismaClient;
  source: StellarSource;
  backfill: BackfillSource;
  watched: WatchedWallets;
  alerter: Alerter;
  logger: Logger;
  networkPassphrase: string;
  /** Test seam: runs inside the batch transaction after each payment (S1 crash simulation). */
  afterPayment?: (payment: NormalizedPayment) => void | Promise<void>;
}

export interface TickResult {
  /** True when more work is waiting and the loop should not sleep. */
  full: boolean;
  processed: number;
}

/**
 * A payment can be seen through two sources with different event ids (RPC vs Horizon).
 * Counts rows the OTHER source already recorded for the same transaction, destination,
 * asset and amount, so the same on-chain movement is never recorded twice.
 */
class CrossSourceDedupe {
  private readonly seen = new Map<string, number>();

  async isDuplicate(tx: Tx, p: NormalizedPayment): Promise<boolean> {
    const hashes = [p.txHash, ...(p.innerTxHash ? [p.innerTxHash] : [])];
    const key = `${hashes.join("|")}|${p.to}|${p.assetCode}|${p.assetIssuer ?? ""}|${p.amountStroops}`;
    const existing = await tx.chainPayment.count({
      where: {
        source: p.source === "rpc" ? "horizon" : "rpc",
        toAddress: p.to,
        assetCode: p.assetCode,
        assetIssuer: p.assetIssuer,
        amountStroops: p.amountStroops,
        OR: [{ txHash: { in: hashes } }, { innerTxHash: { in: hashes } }],
      },
    });
    const seenSoFar = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, seenSoFar);
    return seenSoFar <= existing;
  }
}

export class Ingestion {
  /** Heartbeat for the watchdog: last time a tick finished (successfully or not). */
  lastTickAt = Date.now();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: IngestionDeps) {}

  /** Serialises tick() and reconcile() so they never interleave in this process. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  tick(): Promise<TickResult> {
    return this.exclusive(async () => {
      try {
        return await this.tickInner();
      } finally {
        this.lastTickAt = Date.now();
      }
    });
  }

  reconcile(): Promise<number> {
    return this.exclusive(() => this.reconcileInner());
  }

  async loadCursor(): Promise<Cursor | null> {
    return this.deps.prisma.cursor.findUnique({ where: { name: CURSOR_NAME } });
  }

  private async initCursor(tip: ChainTip): Promise<Cursor> {
    // First boot: no request can predate us, so start at the current tip.
    return this.deps.prisma.cursor.upsert({
      where: { name: CURSOR_NAME },
      update: {},
      create: {
        name: CURSOR_NAME,
        ledger: Math.max(tip.ledger - 1, 0),
        ledgerClosedAt: null,
        networkPassphrase: this.deps.networkPassphrase,
      },
    });
  }

  private async tickInner(): Promise<TickResult> {
    const { prisma, source, watched } = this.deps;
    await watched.ensureFresh();
    const tip = await source.getTip();
    const cursor = (await this.loadCursor()) ?? (await this.initCursor(tip));

    if (isNetworkReset(tip.ledger, cursor.ledger)) {
      await handleNetworkReset(prisma, tip, this.deps.alerter, this.deps.logger);
      return { full: false, processed: 0 };
    }

    const tokenLedger = cursor.pagingToken ? ledgerOfCursor(cursor.pagingToken) : null;
    const usingToken = cursor.pagingToken !== null && tokenLedger !== null;
    const next = usingToken ? tokenLedger : cursor.ledger + 1;

    if (next < tip.oldestLedger) {
      const processed = await this.backfillGap(next, tip);
      return { full: true, processed };
    }
    if (!usingToken && next > tip.ledger) return { full: false, processed: 0 };

    const res = await source.fetch({
      cursor: usingToken ? cursor.pagingToken : null,
      startLedger: next,
      limit: PAGE_LIMIT,
      isWatched: watched.has,
    });

    // One transaction: every payment in the page and the cursor commit together, or not at all.
    const processed = await prisma.$transaction(async (tx) => {
      let count = 0;
      for (const payment of res.payments) {
        const wallet = watched.get(payment.to);
        if (!wallet) continue;
        const result = await processPayment(tx, payment, wallet);
        if (result.inserted) count++;
        await this.deps.afterPayment?.(payment);
      }
      const through = res.processedThrough;
      const ledger = through ? Math.max(through.ledger, cursor.ledger) : cursor.ledger;
      const closedAt =
        through?.closedAt &&
        (!cursor.ledgerClosedAt || through.closedAt.getTime() >= cursor.ledgerClosedAt.getTime())
          ? through.closedAt
          : cursor.ledgerClosedAt;
      await tx.cursor.update({
        where: { name: CURSOR_NAME },
        data: { ledger, ledgerClosedAt: closedAt, pagingToken: res.cursor ?? null },
      });
      return count;
    }, TX_OPTIONS);

    return { full: res.full, processed };
  }

  /**
   * The cursor is older than RPC retention (long outage). Horizon covers ledgers
   * [from, boundary - 1]; RPC resumes at `boundary`. The two ranges never overlap, and
   * CrossSourceDedupe covers the ledger that RPC had only partly delivered.
   */
  private async backfillGap(from: number, tip: ChainTip): Promise<number> {
    const { prisma, backfill, watched, logger } = this.deps;
    const boundary = Math.min(tip.oldestLedger + BACKFILL_MARGIN, tip.ledger);
    const to = boundary - 1;
    logger.warn({ from, to }, "cursor is older than RPC retention; backfilling from Horizon");
    let processed = 0;
    const dedupe = new CrossSourceDedupe();
    for (const wallet of watched.all()) {
      for await (const page of backfill.payments(wallet.address, from, to)) {
        processed += await prisma.$transaction(async (tx) => {
          let count = 0;
          for (const payment of page) {
            if (payment.ledger < from || payment.ledger > to) continue;
            if (await dedupe.isDuplicate(tx, payment)) continue;
            const result = await processPayment(tx, payment, wallet);
            if (result.inserted) count++;
          }
          return count;
        }, TX_OPTIONS);
      }
    }
    // Only now, with every wallet backfilled, does the cursor move. Its close time is left
    // alone (conservative): the next RPC page brings a real one.
    await prisma.cursor.update({
      where: { name: CURSOR_NAME },
      data: { ledger: to, pagingToken: null },
    });
    await this.deps.alerter.alert(
      `Backfilled ledgers ${from}-${to} from Horizon (${processed} payment(s)) after falling out of RPC retention.`,
    );
    return processed;
  }

  /**
   * Re-reads the last `window` processed ledgers and feeds anything to a watched wallet
   * back through the matcher. Event ids make this a no-op unless something was missed
   * (e.g. a wallet added a moment after its first payment).
   */
  private async reconcileInner(window = 60): Promise<number> {
    const { prisma, source, watched } = this.deps;
    const cursor = await this.loadCursor();
    if (!cursor) return 0;
    await watched.ensureFresh();
    const tip = await source.getTip();
    if (isNetworkReset(tip.ledger, cursor.ledger)) return 0; // tick() handles resets
    const upTo = Math.min(cursor.ledger, tip.ledger);
    const start = Math.max(upTo - window + 1, tip.oldestLedger, 1);
    if (start > upTo) return 0;

    let recovered = 0;
    let pageCursor: string | null = null;
    const dedupe = new CrossSourceDedupe();
    for (let page = 0; page < 50; page++) {
      const res = await source.fetch({
        cursor: pageCursor,
        startLedger: start,
        limit: PAGE_LIMIT,
        isWatched: watched.has,
      });
      const inWindow = res.payments.filter((p) => p.ledger <= upTo);
      if (inWindow.length > 0) {
        recovered += await prisma.$transaction(async (tx) => {
          let count = 0;
          for (const payment of inWindow) {
            const wallet = watched.get(payment.to);
            if (!wallet) continue;
            if (await dedupe.isDuplicate(tx, payment)) continue;
            const result = await processPayment(tx, payment, wallet);
            if (result.inserted) count++;
          }
          return count;
        }, TX_OPTIONS);
      }
      const reachedEnd = (res.processedThrough?.ledger ?? 0) >= upTo;
      if (!res.full || reachedEnd || !res.cursor) break;
      pageCursor = res.cursor;
    }
    if (recovered > 0) {
      this.deps.logger.warn({ recovered }, "reconciliation recovered missed payments");
    }
    return recovered;
  }
}
