import type { RequestHandler } from "express";
import { IdempotencyKeySchema } from "@paylink/shared";
import { parse } from "./validate";

/** Validates the optional Idempotency-Key header and exposes it as req.idempotencyKey. */
export const idempotency: RequestHandler = (req, _res, next) => {
  const header = req.get("idempotency-key");
  if (header !== undefined) req.idempotencyKey = parse(IdempotencyKeySchema, header);
  next();
};
