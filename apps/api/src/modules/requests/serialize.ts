import type { ChainPayment, PaymentOutcome, PaymentRequest, RequestEvent } from "@prisma/client";
import type {
  ChainPayment as PaymentDto,
  CheckoutStatus,
  PaymentRequest as RequestDto,
  RequestEvent as RequestEventDto,
} from "@paylink/shared";
import { env } from "../../config/env";
import type { Db } from "../../db/prisma";
import { Account, MuxedAccount } from "@stellar/stellar-sdk";
import { formatStroops } from "../../lib/amount";
import { memoToId } from "../../lib/memo";

export function checkoutUrl(publicId: string): string {
  return `${env.WEB_ORIGIN}/pay/${publicId}`;
}

/** The request's two no-text-memo references: the memo as a number, and wallet + number as an M… address. */
export function numericReference(r: Pick<PaymentRequest, "memo" | "walletAddress">): {
  memoId: string;
  muxedAddress: string;
} {
  const memoId = memoToId(r.memo).toString();
  return { memoId, muxedAddress: new MuxedAccount(new Account(r.walletAddress, "0"), memoId).accountId() };
}

export function remainingStroops(r: Pick<PaymentRequest, "amountStroops" | "receivedStroops">): bigint {
  const remaining = r.amountStroops - r.receivedStroops;
  return remaining > 0n ? remaining : 0n;
}

/** Outcomes where money reached the merchant's wallet but was not applied: it should go back. */
export const REFUNDABLE_OUTCOMES: PaymentOutcome[] = ["DUPLICATE", "LATE", "AFTER_CANCEL", "AFTER_RESET", "WRONG_ASSET"];

/**
 * Funds arrived that the merchant should return: more than was asked, money counted on a
 * request that then closed unpaid, or (`hasRefundablePayment`) any linked payment that was
 * not applied: a duplicate, a late one, one after cancel or reset, or the wrong asset.
 */
export function refundOwed(
  r: Pick<PaymentRequest, "status" | "receivedStroops" | "amountStroops">,
  hasRefundablePayment = false,
): boolean {
  if (hasRefundablePayment || r.receivedStroops > r.amountStroops) return true;
  const closedUnpaid = r.status === "EXPIRED" || r.status === "CANCELLED" || r.status === "NETWORK_RESET";
  return closedUnpaid && r.receivedStroops > 0n;
}

/** Ids, among `requestIds`, of requests that have a payment that should be refunded. */
export async function requestsWithRefundablePayments(db: Db, requestIds: string[]): Promise<Set<string>> {
  if (requestIds.length === 0) return new Set();
  const rows = await db.chainPayment.findMany({
    where: { requestId: { in: requestIds }, outcome: { in: REFUNDABLE_OUTCOMES } },
    select: { requestId: true },
    distinct: ["requestId"],
  });
  return new Set(rows.map((p) => p.requestId).filter((id): id is string => id !== null));
}

/** Serialises requests with the refund flag looked up in one query. */
export async function presentRequests(db: Db, requests: PaymentRequest[]): Promise<RequestDto[]> {
  const refundable = await requestsWithRefundablePayments(db, requests.map((r) => r.id));
  return requests.map((r) => serializeRequest(r, refundable.has(r.id)));
}

export async function presentRequest(db: Db, request: PaymentRequest): Promise<RequestDto> {
  return (await presentRequests(db, [request]))[0] as RequestDto;
}

export function serializeRequest(r: PaymentRequest, hasRefundablePayment = false): RequestDto {
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
    ...numericReference(r),
    description: r.description,
    customerRef: r.customerRef,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    expiresAt: r.expiresAt.toISOString(),
    paidAt: r.paidAt?.toISOString() ?? null,
    paidTxHash: r.paidTxHash,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    refundOwed: refundOwed(r, hasRefundablePayment),
    createdVia: r.createdVia,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    checkoutUrl: checkoutUrl(r.publicId),
  };
}

export interface PaymentView {
  /** False when the linked request belongs to another merchant (a WRONG_WALLET payment seen by the wallet owner). */
  showRequestId?: boolean;
  /** False when the receiving wallet belongs to another merchant (the same payment seen by the request owner). */
  showWalletId?: boolean;
}

/** Internal ids of another merchant's records are never serialised. */
export function serializePayment(p: ChainPayment, view: PaymentView = {}): PaymentDto {
  const { showRequestId = true, showWalletId = true } = view;
  return {
    eventId: p.eventId,
    txHash: p.txHash,
    innerTxHash: p.innerTxHash,
    ledger: p.ledger,
    ledgerClosedAt: p.ledgerClosedAt.toISOString(),
    walletId: showWalletId ? p.walletId : null,
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
