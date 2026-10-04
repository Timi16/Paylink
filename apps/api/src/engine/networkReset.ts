import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { lockRequestById, OPEN_STATUSES, transitionRequest } from "../modules/transitions";
import type { Alerter } from "./alerter";
import { CURSOR_NAME } from "./cursorName";
import type { ChainTip } from "./sources/StellarSource";

/** The tip moved backwards by more than this many ledgers: testnet was wiped. */
export const RESET_THRESHOLD_LEDGERS = 100;

export function isNetworkReset(tipLedger: number, cursorLedger: number): boolean {
  return tipLedger < cursorLedger - RESET_THRESHOLD_LEDGERS;
}

/**
 * Testnet reset: every open request is closed as NETWORK_RESET (its wallet and funds no
 * longer exist), the cursor jumps to the new tip, and the operator is alerted. One
 * transaction, so a crash half-way redoes the whole thing.
 */
export async function handleNetworkReset(
  prisma: PrismaClient,
  tip: ChainTip,
  alerter: Alerter,
  logger: Logger,
): Promise<number> {
  const now = new Date();
  const closed = await prisma.$transaction(
    async (tx) => {
      const open = await tx.paymentRequest.findMany({
        where: { status: { in: OPEN_STATUSES } },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      let count = 0;
      for (const { id } of open) {
        const req = await lockRequestById(tx, id);
        if (!req || !OPEN_STATUSES.includes(req.status)) continue;
        await transitionRequest(tx, id, req.status, "NETWORK_RESET", "network_reset", "system");
        count++;
      }
      // Ledger numbers restart after a reset, so new event ids could collide with old ones
      // and be dropped as duplicates. Move the old ids out of the way.
      const prefix = `reset-${now.getTime()}-`;
      await tx.$executeRaw`
        UPDATE "RequestEvent" SET "paymentEventId" = ${prefix} || "paymentEventId"
        WHERE "paymentEventId" IS NOT NULL AND "paymentEventId" NOT LIKE 'reset-%'`;
      await tx.$executeRaw`
        UPDATE "ChainPayment" SET "eventId" = ${prefix} || "eventId"
        WHERE "eventId" NOT LIKE 'reset-%'`;
      await tx.cursor.update({
        where: { name: CURSOR_NAME },
        data: {
          ledger: tip.ledger,
          pagingToken: null,
          ledgerClosedAt: tip.closedAt,
          lastNetworkResetAt: now,
        },
      });
      return count;
    },
    { timeout: 120_000, maxWait: 15_000 },
  );
  logger.warn({ closed, tip: tip.ledger }, "network reset handled");
  await alerter.alert(
    `Testnet reset detected. ${closed} open request(s) closed as NETWORK_RESET; cursor moved to ledger ${tip.ledger}.`,
  );
  return closed;
}
