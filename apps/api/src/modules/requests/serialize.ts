import type { ChainPayment, PaymentRequest, RequestEvent } from "@prisma/client";
import type {
  ChainPayment as PaymentDto,
  CheckoutStatus,
  PaymentRequest as RequestDto,
  RequestEvent as RequestEventDto,
} from "@paylink/shared";
import { env } from "../../config/env";
import { formatStroops } from "../../lib/amount";

export function checkoutUrl(publicId: string): string {
  return `${env.WEB_ORIGIN}/pay/${publicId}`;
}

export function remainingStroops(r: Pick<PaymentRequest, "amountStroops" | "receivedStroops">): bigint {
  const remaining = r.amountStroops - r.receivedStroops;
  return remaining > 0n ? remaining : 0n;
}

/** Funds arrived that the merchant should return: an overpayment, or money on a closed request. */
export function refundOwed(r: Pick<PaymentRequest, "status" | "receivedStroops">): boolean {
  if (r.status === "OVERPAID") return true;
  const closedUnpaid = r.status === "EXPIRED" || r.status === "CANCELLED" || r.status === "NETWORK_RESET";
  return closedUnpaid && r.receivedStroops > 0n;
}

export function serializeRequest(r: PaymentRequest): RequestDto {
  return {
    id: r.id,
    publicId: r.publicId,
    status: r.status,
    walletId: r.walletId,
    wallet: r.walletAddress,
    asset: { code: r.assetCode, issuer: r.assetIssuer },
    amount: formatStroops(r.amountStroops),
    amountStroops: r.amountStroops.toString(),
    amountReceived: formatStroops(r.receivedStroops),
    amountReceivedStroops: r.receivedStroops.toString(),
    amountRemaining: formatStroops(remainingStroops(r)),
    memo: r.memo,
    description: r.description,
    customerRef: r.customerRef,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    expiresAt: r.expiresAt.toISOString(),
    paidAt: r.paidAt?.toISOString() ?? null,
    paidTxHash: r.paidTxHash,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    refundOwed: refundOwed(r),
    createdVia: r.createdVia,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    checkoutUrl: checkoutUrl(r.publicId),
  };
}

/**
 * `showRequestId` is false when the linked request belongs to another merchant (a
 * WRONG_WALLET payment): the wallet owner sees the payment but not the foreign request id.
 */
export function serializePayment(p: ChainPayment, showRequestId = true): PaymentDto {
  return {
    eventId: p.eventId,
    txHash: p.txHash,
    innerTxHash: p.innerTxHash,
    ledger: p.ledger,
    ledgerClosedAt: p.ledgerClosedAt.toISOString(),
    walletId: p.walletId,
    from: p.fromAddress,
    to: p.toAddress,
    toMuxedId: p.toMuxedId,
    memo: p.memoRaw,
    memoNormalized: p.memoNormalized,
    memoType: p.memoType,
    asset: { code: p.assetCode, issuer: p.assetIssuer },
    amount: formatStroops(p.amountStroops),
    amountStroops: p.amountStroops.toString(),
    eventType: p.eventType,
    source: p.source,
    requestId: showRequestId ? p.requestId : null,
    outcome: p.outcome,
    assignedManually: p.assignedManually,
    assignedAt: p.assignedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  };
}

export function serializeEvent(e: RequestEvent): RequestEventDto {
  return {
    id: e.id,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    reason: e.reason,
    actor: e.actor,
    paymentEventId: e.paymentEventId,
    createdAt: e.createdAt.toISOString(),
  };
}

/** The public SSE payload: status only, nothing about the merchant. */
export function checkoutStatus(r: PaymentRequest): CheckoutStatus {
  return {
    status: r.status,
    amountReceived: formatStroops(r.receivedStroops),
    amountRemaining: formatStroops(remainingStroops(r)),
    paidTxHash: r.paidTxHash,
    expiresAt: r.expiresAt.toISOString(),
  };
}
