import { Router } from "express";
import {
  CreateRequestBody,
  IdParamsSchema,
  ListRequestsQuery,
  MarkRefundedBody,
  RequestStatsQuery,
  SummaryQuery,
} from "@paylink/shared";
import { authOf } from "../../middleware/auth";
import { idempotency } from "../../middleware/idempotency";
import { parse } from "../../middleware/validate";
import type { PrismaClient } from "@prisma/client";
import { checkoutUrl, presentRequest, presentRequests, serializeEvent, serializePayment, serializeRequest } from "./serialize";
import type { RequestService } from "./service";

export function requestRoutes(service: RequestService, prisma: PrismaClient): Router {
  const router = Router();

  router.post("/", idempotency, async (req, res) => {
    const body = parse(CreateRequestBody, req.body);
    const { request, created } = await service.create(authOf(req), body, req.idempotencyKey);
    // 201 for a new request, 200 when an Idempotency-Key replay returns the original.
    res.status(created ? 201 : 200).json({
      request: await presentRequest(prisma, request),
      checkoutUrl: checkoutUrl(request.publicId),
    });
  });

  router.get("/", async (req, res) => {
    const query = parse(ListRequestsQuery, req.query);
    const { data, nextCursor } = await service.list(authOf(req).merchantId, query);
    res.json({ data: await presentRequests(prisma, data), nextCursor });
  });

  // Before "/:id" so "stats" is not read as an id.
  router.get("/stats", async (req, res) => {
    const query = parse(RequestStatsQuery, req.query);
    res.json(await service.stats(authOf(req).merchantId, query));
  });

  router.get("/:id", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    const { request, payments, events } = await service.detail(authOf(req).merchantId, id);
    res.json({
      request: serializeRequest(request, payments),
      payments: payments.map((p) => serializePayment(p, { showWalletId: p.walletId === request.walletId })),
      events: events.map(serializeEvent),
    });
  });

  router.post("/:id/cancel", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json({ request: await presentRequest(prisma, await service.cancel(authOf(req), id)) });
  });

  router.post("/:id/accept", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json({ request: await presentRequest(prisma, await service.accept(authOf(req), id)) });
  });

  router.post("/:id/refunded", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    const { txHash } = parse(MarkRefundedBody, req.body ?? {});
    res.json({ request: await presentRequest(prisma, await service.markRefunded(authOf(req).merchantId, id, txHash)) });
  });

  return router;
}

/** GET /v1/summary: the numbers behind the dashboard overview. */
export function summaryRoutes(service: RequestService): Router {
  const router = Router();
  router.get("/", async (req, res) => {
    const { from } = parse(SummaryQuery, req.query);
    res.json(await service.summary(authOf(req).merchantId, new Date(from)));
  });
  return router;
}
