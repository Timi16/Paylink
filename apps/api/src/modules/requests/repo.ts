import type { ChainPayment, PaymentRequest, Prisma, RequestEvent, RequestStatus } from "@prisma/client";
import type { Db } from "../../db/prisma";

// Every function takes merchantId first and includes it in the where.

export function findRequest(db: Db, merchantId: string, id: string): Promise<PaymentRequest | null> {
  return db.paymentRequest.findFirst({ where: { id, merchantId } });
}

export function findByIdempotencyKey(
  db: Db,
  merchantId: string,
  idempotencyKey: string,
): Promise<PaymentRequest | null> {
  return db.paymentRequest.findFirst({ where: { merchantId, idempotencyKey } });
}

export function createRequest(
  db: Db,
  merchantId: string,
  data: Omit<Prisma.PaymentRequestUncheckedCreateInput, "merchantId">,
): Promise<PaymentRequest> {
  return db.paymentRequest.create({ data: { ...data, merchantId } });
}

export interface ListFilters {
  status?: RequestStatus;
  walletId?: string;
  from?: Date;
  to?: Date;
  /** Normalised memo to match exactly, when q looks like one. */
  memo?: string | null;
  q?: string;
  after?: { createdAt: Date; id: string };
  take: number;
}

export function listRequests(db: Db, merchantId: string, f: ListFilters): Promise<PaymentRequest[]> {
  const and: Prisma.PaymentRequestWhereInput[] = [];
  if (f.q) {
    and.push({
      OR: [
        ...(f.memo ? [{ memo: f.memo }] : []),
        { customerRef: { contains: f.q, mode: "insensitive" as const } },
      ],
    });
  }
  if (f.after) {
    // Keyset pagination on (createdAt desc, id desc).
    and.push({
      OR: [
        { createdAt: { lt: f.after.createdAt } },
        { createdAt: f.after.createdAt, id: { lt: f.after.id } },
      ],
    });
  }
  return db.paymentRequest.findMany({
    where: {
      merchantId,
      ...(f.status ? { status: f.status } : {}),
      ...(f.walletId ? { walletId: f.walletId } : {}),
      ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
      ...(and.length ? { AND: and } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: f.take,
  });
}

export async function requestDetail(
  db: Db,
  merchantId: string,
  id: string,
): Promise<{ request: PaymentRequest; payments: ChainPayment[]; events: RequestEvent[] } | null> {
  const request = await findRequest(db, merchantId, id);
  if (!request) return null;
  const [payments, events] = await Promise.all([
    db.chainPayment.findMany({
      where: { requestId: id },
      orderBy: [{ ledger: "asc" }, { eventId: "asc" }],
    }),
    db.requestEvent.findMany({ where: { requestId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
  ]);
  return { request, payments, events };
}
