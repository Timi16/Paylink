import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Reads X-Request-Id (if it looks sane) or generates one, and echoes it on the response. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get("x-request-id");
  req.requestId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
};
