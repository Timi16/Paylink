import type { PaymentRequest } from "@prisma/client";
import type { CreateRequestBody, ListRequestsQuery, RequestStatsQuery } from "@paylink/shared";
import { CHANNELS, notify } from "../../db/notify";
import { uniqueViolation } from "../../db/prisma";
import type { AppDeps } from "../../deps";
import { formatStroops, parseAmount } from "../../lib/amount";
import { resolveAsset } from "../../lib/asset";
import { decodeCursor, encodeCursor } from "../../lib/cursor";
import { AppError, notFound } from "../../lib/errors";
import { generatePublicId, sha256Hex } from "../../lib/ids";
import { generateMemo, normalizeMemo } from "../../lib/memo";
import type { AuthContext } from "../../middleware/auth";
import { RESET_EVENT_PREFIX } from "../../engine/networkReset";
import { lockRequestById, transitionRequest } from "../transitions";
import { checkCanReceive, RECEIVE_ERROR_MESSAGES } from "../wallets/capability";
import * as walletRepo from "../wallets/repo";
import type { WalletService } from "../wallets/service";
import * as repo from "./repo";
import { presentRequests, REFUNDABLE_OUTCOMES, requestLevelRefund } from "./serialize";

const WALLET_CHECK_MAX_AGE_MS = 5 * 60_000;
const MAX_ID_ATTEMPTS = 5;

/** JSON with sorted keys, so equivalent bodies hash the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface CreateResult {
  request: PaymentRequest;
  /** False when an Idempotency-Key replay returned the original request. */
  created: boolean;
}

export function createRequestService(deps: AppDeps, wallets: WalletService) {
  const { prisma } = deps;

  function replay(existing: PaymentRequest, bodyHash: string): CreateResult {
    if (existing.idempotencyHash !== bodyHash) {
      throw new AppError(
        "IDEMPOTENCY_MISMATCH",
        "This Idempotency-Key was already used with a different request body",
      );
    }
    return { request: existing, created: false };
  }

  async function getOwned(merchantId: string, id: string): Promise<PaymentRequest> {
    const request = await repo.findRequest(prisma, merchantId, id);
    if (!request) throw notFound("Payment request");
    return request;
  }

  return {
    async create(
      auth: AuthContext,
      body: CreateRequestBody,
      idempotencyKey: string | undefined,
    ): Promise<CreateResult> {
      const { merchantId } = auth;
      // The body is hashed after validation, so `{}`-equivalent bodies (defaults, key order)
      // count as the same request.
      const bodyHash = sha256Hex(canonicalJson(body));
      if (idempotencyKey) {
        const existing = await repo.findByIdempotencyKey(prisma, merchantId, idempotencyKey);
        if (existing) return replay(existing, bodyHash);
      }

      const amountStroops = parseAmount(body.amount);
      if (amountStroops === null || amountStroops <= 0n) {
        throw new AppError("VALIDATION_FAILED", "Invalid amount");
      }
      const asset = resolveAsset(body.asset);

      let wallet = await walletRepo.findWallet(prisma, merchantId, body.walletId);
      if (!wallet) throw notFound("Wallet");
      if (!wallet.verifiedAt) {
        throw new AppError("WALLET_NOT_VERIFIED", "Verify this wallet before creating requests");
      }
      wallet = await wallets.ensureFresh(wallet, WALLET_CHECK_MAX_AGE_MS);
      const check = checkCanReceive(wallet, asset, amountStroops);
      if (!check.ok) throw new AppError(check.reason, RECEIVE_ERROR_MESSAGES[check.reason]);

      const expiresAt = new Date(Date.now() + body.expiresInMinutes * 60_000);
      for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
        try {
          // Same per-address lock as adding a wallet: the wallet cannot be removed and the
          // address claimed by someone else between this check and the insert.
          const walletId = wallet.id;
          const address = wallet.address;
          const request = await prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${address}))`;
            if (!(await walletRepo.findWallet(tx, merchantId, walletId))) throw notFound("Wallet");
            return repo.createRequest(tx, merchantId, {
            publicId: generatePublicId(),
            walletId: wallet.id,
            // Snapshot: later wallet edits can never change what this request expects.
            walletAddress: wallet.address,
            assetCode: asset.code,
            assetIssuer: asset.issuer,
            amountStroops,
            memo: generateMemo(),
            description: body.description ?? null,
            customerRef: body.customerRef ?? null,
            ...(body.metadata ? { metadata: body.metadata as object } : {}),
            expiresAt,
            idempotencyKey: idempotencyKey ?? null,
            idempotencyHash: idempotencyKey ? bodyHash : null,
              createdVia: auth.via === "apiKey" ? "api" : "dashboard",
            });
          });
          return { request, created: true };
        } catch (err) {
          const fields = uniqueViolation(err);
          if (!fields) throw err;
          if (idempotencyKey && fields.includes("idempotencyKey")) {
            // A concurrent retry with the same key won the race: return its request.
            const existing = await repo.findByIdempotencyKey(prisma, merchantId, idempotencyKey);
            if (existing) return replay(existing, bodyHash);
          }
          // Otherwise a memo / publicId collision: memos are never reused, so draw again.
        }
      }
      throw new AppError("INTERNAL", "Could not allocate a unique payment reference");
    },

    async list(merchantId: string, query: ListRequestsQuery) {
      const rows = await repo.listRequests(prisma, merchantId, {
        status: query.status,
        walletId: query.walletId,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        q: query.q,
        memo: query.q ? normalizeMemo(query.q) : null,
        after: query.cursor ? decodeCursor(query.cursor) : undefined,
        take: query.limit + 1,
      });
      const data = rows.slice(0, query.limit);
      const last = data[data.length - 1];
      return {
        data,
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },

    async stats(merchantId: string, query: RequestStatsQuery) {
      const byStatus = await repo.requestStats(prisma, merchantId, {
        walletId: query.walletId,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        q: query.q,
        memo: query.q ? normalizeMemo(query.q) : null,
      });
      return { total: Object.values(byStatus).reduce((sum, n) => sum + n, 0), byStatus };
    },

    /**
     * Records that the merchant sent back what the request itself owed: the excess over the
     * amount asked, or money counted before it closed unpaid. PayLink never moves funds;
     * this only clears the refund from the merchant's to-do list.
     */
    async markRefunded(merchantId: string, id: string, txHash: string | undefined): Promise<PaymentRequest> {
      await getOwned(merchantId, id);
      return prisma.$transaction(async (tx) => {
        const req = await lockRequestById(tx, id);
        if (!req || req.merchantId !== merchantId) throw notFound("Payment request");
        if (req.refundedAt) return req; // already recorded
        if (requestLevelRefund(req) === 0n) {
          throw new AppError("INVALID_TRANSITION", "This request has nothing of its own to refund");
        }
        const updated = await tx.paymentRequest.update({
          where: { id },
          data: { refundedAt: new Date(), refundTxHash: txHash ?? null },
        });
        await notify(tx, CHANNELS.requestUpdated, { id, publicId: req.publicId, merchantId });
        return updated;
      });
    },

    /** The numbers behind the dashboard overview. */
    async summary(merchantId: string, from: Date) {
      const now = new Date();
      const [collected, created, settled, open, underpaid, next, unmatched, refundCandidates] = await Promise.all([
        prisma.chainPayment.groupBy({
          by: ["assetCode", "assetIssuer"],
          where: { request: { merchantId }, outcome: "COUNTED", ledgerClosedAt: { gte: from }, NOT: { eventId: { startsWith: RESET_EVENT_PREFIX } } },
          _sum: { amountStroops: true },
          _count: { _all: true },
        }),
        prisma.paymentRequest.count({ where: { merchantId, createdAt: { gte: from } } }),
        prisma.paymentRequest.count({ where: { merchantId, createdAt: { gte: from }, status: { in: ["PAID", "OVERPAID"] } } }),
        prisma.paymentRequest.count({ where: { merchantId, status: { in: ["PENDING", "UNDERPAID"] } } }),
        prisma.paymentRequest.count({ where: { merchantId, status: "UNDERPAID" } }),
        prisma.paymentRequest.findFirst({
          where: { merchantId, status: { in: ["PENDING", "UNDERPAID"] }, expiresAt: { gt: now } },
          orderBy: { expiresAt: "asc" },
          select: { expiresAt: true },
        }),
        prisma.chainPayment.count({
          where: {
            wallet: { merchantId },
            requestId: null,
            refundedAt: null,
            outcome: { in: ["NO_MEMO", "UNKNOWN_MEMO", "MEMO_TYPE_MISMATCH"] },
            NOT: { eventId: { startsWith: RESET_EVENT_PREFIX } },
          },
        }),
        // Anything that could owe a refund; the exact rule (amounts, dust) is applied below.
        prisma.paymentRequest.findMany({
          where: {
            merchantId,
            OR: [
              { status: "OVERPAID", refundedAt: null },
              { status: { in: ["EXPIRED", "CANCELLED", "NETWORK_RESET"] }, receivedStroops: { gt: 0 }, refundedAt: null },
              { payments: { some: { outcome: { in: REFUNDABLE_OUTCOMES }, refundedAt: null, NOT: { eventId: { startsWith: RESET_EVENT_PREFIX } } } } },
            ],
          },
          orderBy: { updatedAt: "desc" },
          take: 200,
        }),
      ]);
      const owing = (await presentRequests(prisma, refundCandidates)).filter((r) => r.refundOwed);
      return {
        from: from.toISOString(),
        collected: collected.map((c) => {
          const stroops = c._sum.amountStroops ?? 0n;
          return {
            asset: { code: c.assetCode, issuer: c.assetIssuer },
            amount: formatStroops(stroops),
            amountStroops: stroops.toString(),
            payments: c._count._all,
          };
        }),
        requests: { created, settled },
        open: { count: open, underpaid, nextExpiresAt: next?.expiresAt.toISOString() ?? null },
        needsYou: { unmatched, refunds: owing.length, refundRequests: owing.slice(0, 3) },
      };
    },

    async detail(merchantId: string, id: string) {
      const detail = await repo.requestDetail(prisma, merchantId, id);
      if (!detail) throw notFound("Payment request");
      return detail;
    },

    /** PENDING only. A request that already received money cannot be cancelled. */
    async cancel(auth: AuthContext, id: string): Promise<PaymentRequest> {
      await getOwned(auth.merchantId, id);
      return prisma.$transaction(async (tx) => {
        const req = await lockRequestById(tx, id);
        if (!req || req.merchantId !== auth.merchantId) throw notFound("Payment request");
        if (req.status !== "PENDING") {
          throw new AppError("INVALID_TRANSITION", `Only a PENDING request can be cancelled; this one is ${req.status}`);
        }
        return transitionRequest(tx, id, "PENDING", "CANCELLED", "cancelled", actorOf(auth), {
          data: { cancelledAt: new Date() },
        });
      });
    },

    /**
     * Merchant accepts what was paid as full payment:
     * - UNDERPAID: accept the partial amount.
     * - EXPIRED with at least one LATE payment: those payments become COUNTED.
     * - CANCELLED with at least one AFTER_CANCEL payment (the customer paid as, or after, the
     *   merchant cancelled): those payments become COUNTED.
     * Either way the request becomes PAID with the received amount recomputed.
     */
    async accept(auth: AuthContext, id: string): Promise<PaymentRequest> {
      await getOwned(auth.merchantId, id);
      return prisma.$transaction(async (tx) => {
        const req = await lockRequestById(tx, id);
        if (!req || req.merchantId !== auth.merchantId) throw notFound("Payment request");

        if (req.refundedAt) {
          // The money this request had received was recorded as sent back; it can't also be kept.
          throw new AppError("INVALID_TRANSITION", "You recorded a refund for this request, so it can't be accepted as paid");
        }
        if (req.status === "EXPIRED" || req.status === "CANCELLED") {
          // The payments that arrived after the request closed, and were set aside for it.
          const outcome = req.status === "EXPIRED" ? "LATE" : "AFTER_CANCEL";
          // Payments from before a testnet reset no longer exist on the network: never counted.
          const setAside = await tx.chainPayment.findMany({
            where: { requestId: id, outcome, NOT: { eventId: { startsWith: RESET_EVENT_PREFIX } } },
            select: { eventId: true },
          });
          if (setAside.length === 0) {
            throw new AppError(
              "INVALID_TRANSITION",
              req.status === "EXPIRED"
                ? "An EXPIRED request can only be accepted once a late payment has arrived"
                : "A CANCELLED request can only be accepted once a payment has arrived for it",
            );
          }
          await tx.chainPayment.updateMany({
            where: { eventId: { in: setAside.map((p) => p.eventId) } },
            data: { outcome: "COUNTED" },
          });
        } else if (req.status !== "UNDERPAID") {
          throw new AppError("INVALID_TRANSITION", `A ${req.status} request cannot be accepted`);
        }

        const counted = await tx.chainPayment.findMany({
          where: { requestId: id, outcome: "COUNTED" },
          orderBy: [{ ledger: "desc" }, { eventId: "desc" }],
          select: { amountStroops: true, txHash: true },
        });
        const received = counted.reduce((sum, p) => sum + p.amountStroops, 0n);
        return transitionRequest(tx, id, req.status, "PAID", "accepted", actorOf(auth), {
          data: { receivedStroops: received, paidAt: new Date(), paidTxHash: counted[0]?.txHash ?? null },
        });
      });
    },
  };
}

export function actorOf(auth: AuthContext): "merchant" | "api" {
  return auth.via === "apiKey" ? "api" : "merchant";
}

export type RequestService = ReturnType<typeof createRequestService>;
