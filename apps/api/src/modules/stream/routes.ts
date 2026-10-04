import { Router } from "express";
import type { AppDeps } from "../../deps";
import { AppError } from "../../lib/errors";
import { authOf } from "../../middleware/auth";
import type { SseRegistry } from "./sse";

const MERCHANT_STREAM_MAX_MS = 15 * 60_000;

/** GET /v1/stream: the dashboard's live feed (session only). */
export function merchantStreamRoutes(deps: AppDeps, sse: SseRegistry): Router {
  const router = Router();
  router.get("/", (req, res) => {
    const { merchantId } = authOf(req);
    const key = `m:${merchantId}`;
    if (sse.count(key) >= deps.limits.sseStreamsPerMerchant) {
      throw new AppError("RATE_LIMITED", "Too many open streams", { retryAfter: 10 });
    }
    if (sse.total >= deps.limits.sseStreamsTotal) {
      throw new AppError("SERVICE_UNAVAILABLE", "Live updates are at capacity", { retryAfter: 30 });
    }
    // Re-authenticated on every reconnect, so a logged-out session loses its feed within this window.
    const stream = sse.open(req, res, key, MERCHANT_STREAM_MAX_MS);
    const unsubscribe = deps.hub.subscribeMerchant(merchantId, (event) => stream.send(event.type, event.data));
    res.on("close", unsubscribe);
    stream.send("ready", { ok: true });
  });
  return router;
}
