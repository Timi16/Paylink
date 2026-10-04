import type { RequestHandler } from "express";
import type { z } from "zod";
import { AppError } from "../lib/errors";

export function zodDetails(error: z.ZodError): { path: string; message: string }[] {
  // Issues never echo the submitted value, so secrets in a rejected body can't leak here.
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** Postgres cannot store NUL in text or jsonb; refuse it up front as a validation error. */
export const rejectNulBytes: RequestHandler = (req, _res, next) => {
  const inBody = req.body !== undefined && JSON.stringify(req.body).includes("\\u0000");
  // Path parameters are matched against strict patterns already; only the query needs this.
  const query = req.originalUrl.split("?")[1] ?? "";
  if (inBody || /%00|\0/.test(query)) {
    return next(new AppError("VALIDATION_FAILED", "Null characters are not allowed"));
  }
  next();
};

/** Parses `data` with a strict Zod schema or throws VALIDATION_FAILED. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = zodDetails(result.error);
    throw new AppError("VALIDATION_FAILED", details[0]?.message ?? "Validation failed", { details });
  }
  return result.data as z.infer<S>;
}
