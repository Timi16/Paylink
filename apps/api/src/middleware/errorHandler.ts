import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import type { ErrorCode } from "@paylink/shared";
import { isDbUnavailable } from "../db/prisma";
import { AppError, HTTP_STATUS } from "../lib/errors";
import { logger } from "../lib/logger";
import { zodDetails } from "./validate";

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError("NOT_FOUND", "Route not found"));
};

function bodyParserError(err: unknown): AppError | null {
  if (typeof err !== "object" || err === null || !("type" in err)) return null;
  const type = (err as { type?: unknown }).type;
  if (type === "entity.too.large") return new AppError("PAYLOAD_TOO_LARGE", "Request body too large");
  if (typeof type === "string" && (type.startsWith("entity.") || type.startsWith("encoding.") || type.startsWith("charset.") || type.startsWith("request."))) {
    return new AppError("VALIDATION_FAILED", "Malformed request body");
  }
  return null;
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    const details = zodDetails(err);
    return new AppError("VALIDATION_FAILED", details[0]?.message ?? "Validation failed", { details });
  }
  const parserError = bodyParserError(err);
  if (parserError) return parserError;
  if (err instanceof URIError) return new AppError("VALIDATION_FAILED", "Malformed URL");
  if (isDbUnavailable(err)) {
    return new AppError("SERVICE_UNAVAILABLE", "Service temporarily unavailable", { retryAfter: 5 });
  }
  return new AppError("INTERNAL", "Something went wrong");
}

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const appError = toAppError(err);
  if (appError.status >= 500) {
    // Full details only in logs; the client gets a generic message.
    (req.log ?? logger).error({ err, requestId: req.requestId }, "request failed");
  }
  if (res.headersSent) {
    res.end();
    return;
  }
  if (appError.retryAfter !== undefined) res.setHeader("Retry-After", String(appError.retryAfter));
  const code: ErrorCode = appError.code;
  res.status(HTTP_STATUS[code]).json({
    error: {
      code,
      message: appError.message,
      details: appError.details,
      requestId: req.requestId ?? "unknown",
    },
  });
};
