import type { PaymentRequest, RequestStatus } from "@prisma/client";
import { CHANNELS, notify } from "../db/notify";
import type { Tx } from "../db/prisma";
import { AppError } from "../lib/errors";

// The ONLY file allowed to change PaymentRequest.status (enforced by an ESLint rule).

export const ALLOWED: Record<RequestStatus, RequestStatus[]> = {
  PENDING: ["UNDERPAID", "PAID", "OVERPAID", "EXPIRED", "CANCELLED", "NETWORK_RESET"],
  UNDERPAID: ["PAID", "OVERPAID", "EXPIRED", "NETWORK_RESET"],
  EXPIRED: ["PAID"], // merchant Accept only
  PAID: [],
  OVERPAID: [],
  CANCELLED: [],
  NETWORK_RESET: [],
};

export const OPEN_STATUSES: RequestStatus[] = ["PENDING", "UNDERPAID"];

export type TransitionReason =
  "payment_counted" | "expired" | "cancelled" | "accepted" | "network_reset";
export type TransitionActor = "system" | "merchant" | "api";

export interface TransitionOptions {
  paymentEventId?: string;
  /** Columns that change together with the status. */
  data?: {
    receivedStroops?: bigint;
    paidAt?: Date;
    paidTxHash?: string | null;
    cancelledAt?: Date;
  };
}

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return ALLOWED[from].includes(to);
}

async function announce(tx: Tx, request: PaymentRequest): Promise<void> {
  // Transactional NOTIFY: subscribers hear about it only once this transaction commits.
  await notify(tx, CHANNELS.requestUpdated, {
    id: request.id,
    publicId: request.publicId,
    merchantId: request.merchantId,
  });
}

/**
 * Moves a request from `expected` to `to`. Must run inside a transaction that holds the
 * row lock on the request. The conditional update (`WHERE status = expected`) makes a stale
 * caller fail with INVALID_TRANSITION instead of overwriting a newer status.
 */
export async function transitionRequest(
  tx: Tx,
  id: string,
  expected: RequestStatus,
  to: RequestStatus,
  reason: TransitionReason,
  actor: TransitionActor,
  opts: TransitionOptions = {},
): Promise<PaymentRequest> {
  if (!canTransition(expected, to)) {
    throw new AppError("INVALID_TRANSITION", `A ${expected} request cannot become ${to}`);
  }
  const updated = await tx.paymentRequest.updateMany({
    where: { id, status: expected },
    data: { status: to, ...opts.data },
  });
  if (updated.count === 0) {
    throw new AppError("INVALID_TRANSITION", `Request is no longer ${expected}`);
  }
  await tx.requestEvent.create({
    data: {
      requestId: id,
      fromStatus: expected,
      toStatus: to,
      reason,
      actor,
      paymentEventId: opts.paymentEventId ?? null,
    },
  });
  const request = await tx.paymentRequest.findUniqueOrThrow({ where: { id } });
  await announce(tx, request);
  return request;
}

/**
 * UNDERPAID -> UNDERPAID: a further partial payment. Not a status change, so it only updates
 * the received amount and appends an audit row.
 */
export async function recordPartialPayment(
  tx: Tx,
  id: string,
  receivedStroops: bigint,
  paymentEventId: string,
): Promise<PaymentRequest> {
  const updated = await tx.paymentRequest.updateMany({
    where: { id, status: "UNDERPAID" },
    data: { receivedStroops },
  });
  if (updated.count === 0) {
    throw new AppError("INVALID_TRANSITION", "Request is no longer UNDERPAID");
  }
  await tx.requestEvent.create({
    data: {
      requestId: id,
      fromStatus: "UNDERPAID",
      toStatus: "UNDERPAID",
      reason: "payment_counted",
      actor: "system",
      paymentEventId,
    },
  });
  const request = await tx.paymentRequest.findUniqueOrThrow({ where: { id } });
  await announce(tx, request);
  return request;
}

/** SELECT … FOR UPDATE on one request; returns the fresh row or null. */
export async function lockRequestById(tx: Tx, id: string): Promise<PaymentRequest | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "PaymentRequest" WHERE "id" = ${id} FOR UPDATE`;
  if (rows.length === 0) return null;
  return tx.paymentRequest.findUnique({ where: { id } });
}

export async function lockRequestByMemo(tx: Tx, memo: string): Promise<PaymentRequest | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "PaymentRequest" WHERE "memo" = ${memo} FOR UPDATE`;
  const id = rows[0]?.id;
  if (!id) return null;
  return tx.paymentRequest.findUnique({ where: { id } });
}
