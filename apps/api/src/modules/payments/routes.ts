import { Router } from "express";
import { AssignPaymentBody, EventIdParamsSchema, ListPaymentsQuery } from "@paylink/shared";
import { authOf } from "../../middleware/auth";
import { parse } from "../../middleware/validate";
import type { PrismaClient } from "@prisma/client";
import { presentRequest, serializePayment } from "../requests/serialize";
import type { PaymentService } from "./service";

export function paymentRoutes(service: PaymentService, prisma: PrismaClient): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const merchantId = authOf(req).merchantId;
    const query = parse(ListPaymentsQuery, req.query);
    const { data, suggestions, nextCursor } = await service.list(merchantId, query);
    res.json({
      data: data.map((p) =>
        serializePayment(p, {
          showRequestId: !p.request || p.request.merchantId === merchantId,
          suggestedRequestId: suggestions.get(p.eventId) ?? null,
        }),
      ),
      nextCursor,
    });
  });

  router.post("/:eventId/assign", async (req, res) => {
    const { eventId } = parse(EventIdParamsSchema, req.params);
    const { requestId } = parse(AssignPaymentBody, req.body);
    const { payment, request } = await service.assign(authOf(req).merchantId, eventId, requestId);
    res.json({ payment: serializePayment(payment), request: await presentRequest(prisma, request) });
  });

  return router;
}
