import type { PaymentRequest } from "@prisma/client";
import type { CreateRequestBody, ListRequestsQuery } from "@paylink/shared";
import { uniqueViolation } from "../../db/prisma";
import type { AppDeps } from "../../deps";
import { parseAmount } from "../../lib/amount";
import { resolveAsset } from "../../lib/asset";
import { decodeCursor, encodeCursor } from "../../lib/cursor";
import { AppError, notFound } from "../../lib/errors";
import { generatePublicId, sha256Hex } from "../../lib/ids";
import { generateMemo, normalizeMemo } from "../../lib/memo";
import type { AuthContext } from "../../middleware/auth";
import { lockRequestById, transitionRequest } from "../transitions";
import { checkCanReceive, RECEIVE_ERROR_MESSAGES } from "../wallets/capability";
import * as walletRepo from "../wallets/repo";
import type { WalletService } from "../wallets/service";
import * as repo from "./repo";

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
          const request = await repo.createRequest(prisma, merchantId, {
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
     * Either way the request becomes PAID with the received amount recomputed.
     */
    async accept(auth: AuthContext, id: string): Promise<PaymentRequest> {
      await getOwned(auth.merchantId, id);
      return prisma.$transaction(async (tx) => {
        const req = await lockRequestById(tx, id);
        if (!req || req.merchantId !== auth.merchantId) throw notFound("Payment request");

        if (req.status === "EXPIRED") {
          const late = await tx.chainPayment.findMany({
            where: { requestId: id, outcome: "LATE" },
            select: { eventId: true },
          });
          if (late.length === 0) {
            throw new AppError("INVALID_TRANSITION", "An EXPIRED request can only be accepted once a late payment has arrived");
          }
          await tx.chainPayment.updateMany({
            where: { eventId: { in: late.map((p) => p.eventId) } },
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
