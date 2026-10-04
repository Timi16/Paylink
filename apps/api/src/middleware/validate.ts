import type { z } from "zod";
import { AppError } from "../lib/errors";

export function zodDetails(error: z.ZodError): { path: string; message: string }[] {
  // Issues never echo the submitted value, so secrets in a rejected body can't leak here.
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** Parses `data` with a strict Zod schema or throws VALIDATION_FAILED. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = zodDetails(result.error);
    throw new AppError("VALIDATION_FAILED", details[0]?.message ?? "Validation failed", { details });
  }
  return result.data as z.infer<S>;
}
