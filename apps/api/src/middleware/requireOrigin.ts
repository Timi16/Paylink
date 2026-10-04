import type { RequestHandler } from "express";
import { env } from "../config/env";
import { AppError } from "../lib/errors";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * CSRF guard for cookie-authenticated routes: state-changing requests must carry an Origin
 * (or, failing that, a Referer) equal to WEB_ORIGIN. API-key requests are exempt because
 * browsers never attach a bearer token on their own.
 */
export const requireOrigin: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method) || req.auth?.via === "apiKey") return next();
  const origin = originOf(req.get("origin")) ?? originOf(req.get("referer"));
  if (origin !== env.WEB_ORIGIN) {
    return next(new AppError("FORBIDDEN_ORIGIN", "Request origin not allowed"));
  }
  next();
};
