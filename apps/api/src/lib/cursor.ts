import { AppError } from "./errors";

/** Opaque keyset cursor: base64url of [ISO createdAt, id]. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      const createdAt = new Date(parsed[0]);
      if (!Number.isNaN(createdAt.getTime()) && parsed[1].length <= 128) {
        return { createdAt, id: parsed[1] };
      }
    }
  } catch {
    // fall through
  }
  throw new AppError("VALIDATION_FAILED", "Invalid cursor", {
    details: [{ path: "cursor", message: "Invalid cursor" }],
  });
}
