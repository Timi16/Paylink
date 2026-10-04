import pino from "pino";
import { env } from "../config/env";

// Never log secrets: passwords, API keys, session tokens, Authorization headers, Stellar seeds.
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.password",
  "*.currentPassword",
  "*.newPassword",
  "*.passwordHash",
  "*.key",
  "*.keyHash",
  "*.token",
  "*.secret",
  "*.signature",
  "password",
  "key",
  "token",
  "secret",
];

/** Errors are logged as type, message, code and stack only: HTTP client errors carry the
 *  whole request config (URLs, headers), which has no place in logs. */
function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err) };
  const code = (err as { code?: unknown }).code;
  return {
    type: err.name,
    message: err.message,
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    stack: err.stack,
    ...(err.cause instanceof Error ? { cause: err.cause.message } : {}),
  };
}

export const logger = pino({
  serializers: { err: serializeError },
  level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  base: undefined,
});
