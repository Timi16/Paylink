import type { ChainPayment, PaymentOutcome, PaymentRequest } from "@prisma/client";
import { CHANNELS, notify } from "../db/notify";
import type { Tx } from "../db/prisma";
import { normalizeMemo } from "../lib/memo";
import {
  lockRequestByMemo,
  recordPartialPayment,
  transitionRequest,
} from "../modules/transitions";
import type { NormalizedPayment } from "./types";

export interface ProcessResult {
  /** false when this event id was already recorded (replay, reconciliation). */
  inserted: boolean;
  outcome?: PaymentOutcome;
  requestId?: string | null;
}

interface PaymentFacts {
  eventId: string;
  txHash: string;
  ledgerClosedAt: Date;
  toAddress: string;
  assetCode: string;
  assetIssuer: string | null;
  amountStroops: bigint;
}

/** Wallet / asset / issuer checks, in the order the outcome table defines. */
export function targetMismatch(
  payment: Pick<PaymentFacts, "toAddress" | "assetCode" | "assetIssuer">,
  req: Pick<PaymentRequest, "walletAddress" | "assetCode" | "assetIssuer">,
): "WRONG_WALLET" | "WRONG_ASSET" | "WRONG_ISSUER" | null {
  if (req.walletAddress !== payment.toAddress) return "WRONG_WALLET";
  if (payment.assetCode !== req.assetCode) return "WRONG_ASSET";
  if ((payment.assetIssuer ?? null) !== (req.assetIssuer ?? null)) return "WRONG_ISSUER";
  return null;
}

/**
 * The status switch: decides the outcome for a payment that targets the right wallet and
 * asset, and applies it. `req` must be locked FOR UPDATE by the caller's transaction.
 * Shared by automatic matching and manual assignment.
 */
export async function applyToRequest(
  tx: Tx,
  payment: PaymentFacts,
  req: PaymentRequest,
): Promise<PaymentOutcome> {
  switch (req.status) {
    case "PAID":
    case "OVERPAID":
      return "DUPLICATE";
    case "CANCELLED":
      return "AFTER_CANCEL";
    case "NETWORK_RESET":
      return "AFTER_RESET";
    case "EXPIRED":
      return "LATE";
    case "PENDING":
    case "UNDERPAID": {
      // Ledger close time decides expiry, never the server clock.
      if (payment.ledgerClosedAt.getTime() > req.expiresAt.getTime()) {
        await transitionRequest(tx, req.id, req.status, "EXPIRED", "expired", "system");
        return "LATE";
      }
      const received = req.receivedStroops + payment.amountStroops;
      const to =
        received === req.amountStroops ? "PAID" : received < req.amountStroops ? "UNDERPAID" : "OVERPAID";
      if (req.status === "UNDERPAID" && to === "UNDERPAID") {
        await recordPartialPayment(tx, req.id, received, payment.eventId);
        return "COUNTED";
      }
      await transitionRequest(tx, req.id, req.status, to, "payment_counted", "system", {
        paymentEventId: payment.eventId,
        data:
          to === "UNDERPAID"
            ? { receivedStroops: received }
            : { receivedStroops: received, paidAt: payment.ledgerClosedAt, paidTxHash: payment.txHash },
      });
      return "COUNTED";
    }
  }
}

// Postgres text cannot hold NUL; memo bytes come from the chain, so clean them.
function sanitizeText(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.replace(/\u0000/g, "").slice(0, max);
}

/**
 * Turns one detected payment into exactly one outcome. Runs inside the ingestion batch
 * transaction, so the payment row, the request change and the cursor commit together.
 */
export async function processPayment(
  tx: Tx,
  payment: NormalizedPayment,
  wallet: { id: string; merchantId: string },
): Promise<ProcessResult> {
  const memoRaw = sanitizeText(payment.memoRaw, 128);
  // Idempotency guard: the event id is the primary key. A concurrent transaction inserting
  // the same id blocks here until the other commits, then sees the conflict.
  const inserted = await tx.chainPayment.createMany({
    data: [
      {
        eventId: payment.eventId,
        txHash: payment.txHash,
        innerTxHash: payment.innerTxHash,
        ledger: payment.ledger,
        ledgerClosedAt: payment.ledgerClosedAt,
        walletId: wallet.id,
        fromAddress: payment.from,
        toAddress: payment.to,
        toMuxedId: payment.toMuxedId,
        memoRaw,
        memoType: payment.memoType,
        assetCode: payment.assetCode,
        assetIssuer: payment.assetIssuer,
        amountStroops: payment.amountStroops,
        eventType: payment.eventType,
        source: payment.source,
        outcome: "NO_MEMO", // provisional; replaced below in the same transaction
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count === 0) return { inserted: false };

  let outcome: PaymentOutcome;
  let requestId: string | null = null;
  let memoNormalized: string | null = null;

  if (payment.memoType === "none" || memoRaw === null || memoRaw === "") {
    outcome = "NO_MEMO";
  } else if (payment.memoType !== "text") {
    outcome = "MEMO_TYPE_MISMATCH";
  } else {
    memoNormalized = normalizeMemo(memoRaw);
    const req = memoNormalized ? await lockRequestByMemo(tx, memoNormalized) : null;
    if (!req) {
      outcome = "UNKNOWN_MEMO";
    } else {
      requestId = req.id; // every outcome below shows on the request
      const facts: PaymentFacts = {
        eventId: payment.eventId,
        txHash: payment.txHash,
        ledgerClosedAt: payment.ledgerClosedAt,
        toAddress: payment.to,
        assetCode: payment.assetCode,
        assetIssuer: payment.assetIssuer,
        amountStroops: payment.amountStroops,
      };
      outcome = targetMismatch(facts, req) ?? (await applyToRequest(tx, facts, req));
    }
  }

  await tx.chainPayment.update({
    where: { eventId: payment.eventId },
    data: { outcome, requestId, memoNormalized },
  });
  await notify(tx, CHANNELS.paymentDetected, {
    eventId: payment.eventId,
    merchantId: wallet.merchantId,
  });
  return { inserted: true, outcome, requestId };
}

export function paymentFacts(row: ChainPayment): PaymentFacts {
  return {
    eventId: row.eventId,
    txHash: row.txHash,
    ledgerClosedAt: row.ledgerClosedAt,
    toAddress: row.toAddress,
    assetCode: row.assetCode,
    assetIssuer: row.assetIssuer,
    amountStroops: row.amountStroops,
  };
}
