import { Router } from "express";
import { CreateRequestBody, IdParamsSchema, ListRequestsQuery } from "@paylink/shared";
import { authOf } from "../../middleware/auth";
import { idempotency } from "../../middleware/idempotency";
import { parse } from "../../middleware/validate";
import { checkoutUrl, serializeEvent, serializePayment, serializeRequest } from "./serialize";
import type { RequestService } from "./service";

export function requestRoutes(service: RequestService): Router {
  const router = Router();

  router.post("/", idempotency, async (req, res) => {
    const body = parse(CreateRequestBody, req.body);
    const { request, created } = await service.create(authOf(req), body, req.idempotencyKey);
    // 201 for a new request, 200 when an Idempotency-Key replay returns the original.
    res.status(created ? 201 : 200).json({
      request: serializeRequest(request),
      checkoutUrl: checkoutUrl(request.publicId),
    });
  });

  router.get("/", async (req, res) => {
    const query = parse(ListRequestsQuery, req.query);
    const { data, nextCursor } = await service.list(authOf(req).merchantId, query);
    res.json({ data: data.map(serializeRequest), nextCursor });
  });

  router.get("/:id", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    const { request, payments, events } = await service.detail(authOf(req).merchantId, id);
    res.json({
      request: serializeRequest(request),
      payments: payments.map((p) => serializePayment(p)),
      events: events.map(serializeEvent),
    });
  });

  router.post("/:id/cancel", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json({ request: serializeRequest(await service.cancel(authOf(req), id)) });
  });

  router.post("/:id/accept", async (req, res) => {
    const { id } = parse(IdParamsSchema, req.params);
    res.json({ request: serializeRequest(await service.accept(authOf(req), id)) });
  });

  return router;
}
