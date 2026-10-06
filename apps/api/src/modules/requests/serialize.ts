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
 * Below this (0.01 of the asset) an amount is dust: it is still listed in `refundDue`, but
 * it does not raise the `refundOwed` flag. The memo is public, so anyone can attach a
 * one-stroop payment to a request; the flag must not be something a stranger can set for free.
 */
export const REFUND_DUST_STROOPS = 100_000n;

export interface RefundablePayment {
  eventId: string;
  outcome: PaymentOutcome;
  assetCode: string;
  assetIssuer: string | null;
  amountStroops: bigint;
  /** Set once the merchant recorded sending it back. */
  refundedAt?: Date | null;
}

export interface RefundLine {
  asset: { code: string; issuer: string | null };
  amountStroops: bigint;
}

/**
 * What the merchant should send back for a request, per asset:
 * - anything received beyond the amount asked (overpaid, or accepted for more than asked);
 * - everything counted on a request that then closed unpaid;
 * - every linked payment that was not applied: a duplicate, a late one, one after cancel
 *   or reset, or one in the wrong asset.
 * Payments from before a testnet reset are excluded: that money no longer exists. So is
 * anything the merchant has already recorded as refunded.
 */
export function refundDue(
  r: Pick<PaymentRequest, "status" | "receivedStroops" | "amountStroops" | "assetCode" | "assetIssuer"> & { refundedAt?: Date | null },
  payments: RefundablePayment[] = [],
): RefundLine[] {
  const totals = new Map<string, RefundLine>();
  const add = (code: string, issuer: string | null, amount: bigint) => {
    if (amount <= 0n) return;
    const key = `${code}|${issuer ?? ""}`;
    const line = totals.get(key) ?? { asset: { code, issuer }, amountStroops: 0n };
    line.amountStroops += amount;
    totals.set(key, line);
  };
  if (!r.refundedAt) add(r.assetCode, r.assetIssuer, requestLevelRefund(r));
  for (const p of payments) {
    if (!REFUNDABLE_OUTCOMES.includes(p.outcome) || p.eventId.startsWith("reset-") || p.refundedAt) continue;
    add(p.assetCode, p.assetIssuer, p.amountStroops);
  }
  return [...totals.values()];
}

/** What the request itself owes back, apart from unapplied payments: the excess, or money counted before it closed unpaid. */
export function requestLevelRefund(r: Pick<PaymentRequest, "status" | "receivedStroops" | "amountStroops">): bigint {
  const closedUnpaid = r.status === "EXPIRED" || r.status === "CANCELLED" || r.status === "NETWORK_RESET";
  const owed = closedUnpaid ? r.receivedStroops : r.receivedStroops - r.amountStroops;
  return owed > 0n ? owed : 0n;
}

/** True when at least one asset's refund is more than dust. */
export function refundOwed(lines: RefundLine[]): boolean {
  return lines.some((l) => l.amountStroops >= REFUND_DUST_STROOPS);
}

/** Serialises requests with their refund amounts looked up in one query. */
export async function presentRequests(db: Db, requests: PaymentRequest[]): Promise<RequestDto[]> {
  const rows =
    requests.length === 0
      ? []
      : await db.chainPayment.findMany({
          where: { requestId: { in: requests.map((r) => r.id) }, outcome: { in: REFUNDABLE_OUTCOMES } },
          select: { requestId: true, eventId: true, outcome: true, assetCode: true, assetIssuer: true, amountStroops: true, refundedAt: true },
        });
  return requests.map((r) => serializeRequest(r, rows.filter((p) => p.requestId === r.id)));
}

export async function presentRequest(db: Db, request: PaymentRequest): Promise<RequestDto> {
  return (await presentRequests(db, [request]))[0] as RequestDto;
}

export function serializeRequest(r: PaymentRequest, payments: RefundablePayment[] = []): RequestDto {
  const due = refundDue(r, payments);
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
    refundedAt: r.refundedAt?.toISOString() ?? null,
    refundOwed: refundOwed(due),
    refundDue: due.map((l) => ({ asset: l.asset, amount: formatStroops(l.amountStroops), amountStroops: l.amountStroops.toString() })),
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
  /** Unmatched payments only: the one open request this payment exactly settles, if any. */
  suggestedRequestId?: string | null;
}

/** Internal ids of another merchant's records are never serialised. */
export function serializePayment(p: ChainPayment, view: PaymentView = {}): PaymentDto {
  const { showRequestId = true, showWalletId = true, suggestedRequestId = null } = view;
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
    matchedBy: showRequestId ? p.matchedBy : null,
    suggestedRequestId,
    assignedManually: p.assignedManually,
    assignedAt: p.assignedAt?.toISOString() ?? null,
    refundedAt: p.refundedAt?.toISOString() ?? null,
    refundTxHash: p.refundTxHash,
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
    paidAt: r.paidAt?.toISOString() ?? null,
    expiresAt: r.expiresAt.toISOString(),
  };
}
