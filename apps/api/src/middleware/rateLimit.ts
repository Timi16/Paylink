import type { Request, RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { AppError } from "../lib/errors";

export interface LimiterOptions {
  windowMs?: number;
  limit: number;
  /** Defaults to the client IP (honours `trust proxy`). */
  key?: (req: Request) => string;
}

/** Fixed-window limiter that answers with the shared error shape and Retry-After. */
export function limiter(opts: LimiterOptions): RequestHandler {
  const windowMs = opts.windowMs ?? 60_000;
  return rateLimit({
    windowMs,
    limit: opts.limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    ...(opts.key ? { keyGenerator: opts.key } : {}),
    handler: (req, _res, next) => {
      const info = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit;
      const resetMs = info?.resetTime ? info.resetTime.getTime() - Date.now() : windowMs;
      const retryAfter = Math.max(1, Math.ceil(resetMs / 1000));
      next(new AppError("RATE_LIMITED", "Too many requests, slow down", { retryAfter }));
    },
  });
}
