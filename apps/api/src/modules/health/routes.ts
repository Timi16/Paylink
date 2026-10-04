import { Router } from "express";
import type { Health } from "@paylink/shared";
import type { AppDeps } from "../../deps";
import { CURSOR_NAME } from "../../engine/cursorName";
import { OPEN_STATUSES } from "../transitions";

/** DB status, last processed ledger, lag in seconds, open request count. 503 when the DB is down. */
export function healthRoutes(deps: AppDeps): Router {
  const router = Router();
  router.get("/", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const [cursor, openRequests] = await Promise.all([
        deps.prisma.cursor.findUnique({ where: { name: CURSOR_NAME } }),
        deps.prisma.paymentRequest.count({ where: { status: { in: OPEN_STATUSES } } }),
      ]);
      const lagSeconds = cursor?.ledgerClosedAt
        ? Math.max(0, Math.round((Date.now() - cursor.ledgerClosedAt.getTime()) / 1000))
        : null;
      const body: Health = {
        status: "ok",
        db: "up",
        network: "testnet",
        lastProcessedLedger: cursor?.ledger ?? null,
        lagSeconds,
        openRequests,
      };
      res.json(body);
    } catch (err) {
      deps.logger.error({ err }, "health check failed");
      const body: Health = {
        status: "degraded",
        db: "down",
        network: "testnet",
        lastProcessedLedger: null,
        lagSeconds: null,
        openRequests: null,
      };
      res.status(503).json(body);
    }
  });
  return router;
}
