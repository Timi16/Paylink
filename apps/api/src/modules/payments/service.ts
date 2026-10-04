import type { ChainPayment, PaymentRequest } from "@prisma/client";
import { UNMATCHED_OUTCOMES, type ListPaymentsQuery, type PaymentOutcome } from "@paylink/shared";
import { CHANNELS, notify } from "../../db/notify";
import type { AppDeps } from "../../deps";
import { applyToRequest, paymentFacts, targetMismatch } from "../../engine/matcher";
import { RESET_EVENT_PREFIX } from "../../engine/networkReset";
import { decodeCursor, encodeCursor } from "../../lib/cursor";
import { AppError, notFound } from "../../lib/errors";
import * as requestRepo from "../requests/repo";
import { lockRequestById } from "../transitions";
import * as repo from "./repo";

const isUnmatched = (outcome: PaymentOutcome): boolean =>
  (UNMATCHED_OUTCOMES as readonly PaymentOutcome[]).includes(outcome);

export function createPaymentService(deps: AppDeps) {
  const { prisma } = deps;
  return {
    async list(merchantId: string, query: ListPaymentsQuery) {
      const rows = await repo.listPayments(prisma, merchantId, {
        walletId: query.walletId,
        outcome: query.outcome,
        unmatched: query.unmatched === "true",
        after: query.cursor ? decodeCursor(query.cursor) : undefined,
        take: query.limit + 1,
      });
      const data = rows.slice(0, query.limit);
      const last = data[data.length - 1];
      return {
        data,
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdAt, last.eventId) : null,
      };
    },

    /**
     * Manually ties an unmatched payment (no memo, unknown memo, wrong memo type) to one of
     * the merchant's requests on the same wallet and asset, then runs the normal decision
     * path from the status switch onward. The result can be COUNTED, but also DUPLICATE,
     * LATE, AFTER_CANCEL or AFTER_RESET, exactly as if the memo had been right.
     */
    async assign(
      merchantId: string,
      eventId: string,
      requestId: string,
    ): Promise<{ payment: ChainPayment; request: PaymentRequest }> {
      if (!(await repo.findPayment(prisma, merchantId, eventId))) throw notFound("Payment");
      if (!(await requestRepo.findRequest(prisma, merchantId, requestId))) {
        throw notFound("Payment request");
      }
      return prisma.$transaction(async (tx) => {
        // Lock the payment row so two concurrent assigns cannot both count it.
        await tx.$queryRaw`SELECT "eventId" FROM "ChainPayment" WHERE "eventId" = ${eventId} FOR UPDATE`;
        const payment = await repo.findPayment(tx, merchantId, eventId);
        if (!payment) throw notFound("Payment");
        if (payment.requestId !== null || !isUnmatched(payment.outcome)) {
          throw new AppError("PAYMENT_NOT_ASSIGNABLE", "Only unmatched payments can be assigned to a request");
        }
        if (payment.eventId.startsWith(RESET_EVENT_PREFIX)) {
          // Those funds were wiped with the old network; they cannot pay a new request.
          throw new AppError("PAYMENT_NOT_ASSIGNABLE", "This payment was made before a testnet reset and no longer exists on the network");
        }
        const req = await lockRequestById(tx, requestId);
        if (!req || req.merchantId !== merchantId) throw notFound("Payment request");
        const facts = paymentFacts(payment);
        const mismatch = targetMismatch(facts, req);
        if (mismatch) {
          throw new AppError(
            "PAYMENT_NOT_ASSIGNABLE",
            mismatch === "WRONG_WALLET"
              ? "This payment went to a different wallet than the request expects"
              : "This payment is in a different asset than the request expects",
          );
        }
        const outcome = await applyToRequest(tx, facts, req);
        const updated = await tx.chainPayment.update({
          where: { eventId },
          data: { outcome, requestId, assignedManually: true, assignedAt: new Date() },
        });
        await notify(tx, CHANNELS.paymentDetected, { eventId, merchantId });
        const request = await tx.paymentRequest.findUniqueOrThrow({ where: { id: requestId } });
        return { payment: updated, request };
      });
    },
  };
}

export type PaymentService = ReturnType<typeof createPaymentService>;
