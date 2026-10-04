import type { PrismaClient } from "@prisma/client";
import { lockRequestById, OPEN_STATUSES, transitionRequest } from "../modules/transitions";
import { CURSOR_NAME } from "./cursorName";

export const SWEEP_INTERVAL_MS = 15_000;

/**
 * Expires open requests, but only once BOTH the clock and the last fully processed ledger
 * are past expiresAt. If ingestion lags, the cutoff lags with it, so a request that was
 * paid in time but not yet ingested is never expired early.
 */
export async function sweepExpired(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const cursor = await prisma.cursor.findUnique({ where: { name: CURSOR_NAME } });
  if (!cursor?.ledgerClosedAt) return 0; // nothing processed yet: no safe cutoff
  const cutoff = new Date(Math.min(now.getTime(), cursor.ledgerClosedAt.getTime()));

  const due = await prisma.paymentRequest.findMany({
    where: { status: { in: OPEN_STATUSES }, expiresAt: { lt: cutoff } },
    select: { id: true },
    orderBy: { expiresAt: "asc" },
    take: 100,
  });

  let expired = 0;
  for (const { id } of due) {
    const done = await prisma.$transaction(async (tx) => {
      const req = await lockRequestById(tx, id);
      // Re-check under the lock: a payment may have landed since the select.
      if (!req || !OPEN_STATUSES.includes(req.status)) return false;
      if (req.expiresAt.getTime() >= cutoff.getTime()) return false;
      await transitionRequest(tx, id, req.status, "EXPIRED", "expired", "system");
      return true;
    });
    if (done) expired++;
  }
  return expired;
}
