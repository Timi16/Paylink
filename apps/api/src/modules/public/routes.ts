import { Router } from "express";
import { PublicIdParamsSchema, type CheckoutStatus } from "@paylink/shared";
import type { AppDeps } from "../../deps";
import { AppError } from "../../lib/errors";
import { checkoutStatus } from "../requests/serialize";
import { OPEN_STATUSES } from "../transitions";
import type { SseRegistry } from "../stream/sse";
import type { PublicService } from "./service";

const CLOSE_AFTER_TERMINAL_MS = 5000;

export function publicRoutes(deps: AppDeps, service: PublicService, sse: SseRegistry): Router {
  const router = Router();

  router.get("/pay/:publicId", async (req, res) => {
    // An id that is not even well-formed is simply an unknown link.
    const params = PublicIdParamsSchema.safeParse(req.params);
    if (!params.success) throw new AppError("NOT_FOUND", "Payment request not found");
    res.set("Cache-Control", "no-store");
    res.json(await service.checkout(params.data.publicId));
  });

  router.get("/pay/:publicId/events", async (req, res) => {
    const params = PublicIdParamsSchema.safeParse(req.params);
    if (!params.success) throw new AppError("NOT_FOUND", "Payment request not found");
    const { publicId } = params.data;
    const key = `ip:${req.ip ?? "unknown"}`;
    if (sse.count(key) >= deps.limits.sseStreamsPerIp) {
      throw new AppError("RATE_LIMITED", "Too many open streams from this address", { retryAfter: 10 });
    }
    if (sse.total >= deps.limits.sseStreamsTotal) {
      throw new AppError("SERVICE_UNAVAILABLE", "Live updates are at capacity", { retryAfter: 30 });
    }
    await service.findRequest(publicId); // 404 before the stream opens

    const stream = sse.open(req, res, key);
    let closeTimer: NodeJS.Timeout | null = null;
    const push = (status: CheckoutStatus) => {
      stream.send("status", status);
      // The stream has done its job once the request is no longer open.
      if (!closeTimer && !(OPEN_STATUSES as string[]).includes(status.status)) {
        closeTimer = setTimeout(stream.close, CLOSE_AFTER_TERMINAL_MS);
        closeTimer.unref();
      }
    };
    // Subscribe first, then send the snapshot: a change in between is delivered, not lost.
    const unsubscribe = deps.hub.subscribePublic(publicId, push);
    req.on("close", () => {
      unsubscribe();
      if (closeTimer) clearTimeout(closeTimer);
    });
    push(checkoutStatus(await service.findRequest(publicId)));
  });

  return router;
}
