import type { ChainPayment, PaymentOutcome, Prisma } from "@prisma/client";
import { UNMATCHED_OUTCOMES } from "@paylink/shared";
import type { Db } from "../../db/prisma";

// Payments belong to a merchant through the wallet they arrived at.

export type PaymentWithOwner = ChainPayment & { request: { merchantId: string } | null };

export interface PaymentFilters {
  walletId?: string;
  outcome?: PaymentOutcome;
  unmatched?: boolean;
  after?: { createdAt: Date; id: string };
  take: number;
}

export function listPayments(db: Db, merchantId: string, f: PaymentFilters): Promise<PaymentWithOwner[]> {
  const and: Prisma.ChainPaymentWhereInput[] = [];
  if (f.unmatched) and.push({ outcome: { in: [...UNMATCHED_OUTCOMES] }, requestId: null });
  if (f.after) {
    and.push({
      OR: [
        { createdAt: { lt: f.after.createdAt } },
        { createdAt: f.after.createdAt, eventId: { lt: f.after.id } },
      ],
    });
  }
  return db.chainPayment.findMany({
    where: {
      wallet: { merchantId },
      ...(f.walletId ? { walletId: f.walletId } : {}),
      ...(f.outcome ? { outcome: f.outcome } : {}),
      ...(and.length ? { AND: and } : {}),
    },
    include: { request: { select: { merchantId: true } } },
    orderBy: [{ createdAt: "desc" }, { eventId: "desc" }],
    take: f.take,
  });
}

export function findPayment(db: Db, merchantId: string, eventId: string): Promise<ChainPayment | null> {
  return db.chainPayment.findFirst({ where: { eventId, wallet: { merchantId } } });
}
