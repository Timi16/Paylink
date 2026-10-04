import type { ErrorCode } from "@paylink/shared";

export const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  SECRET_KEY_REJECTED: 400,
  WALLET_NOT_VERIFIED: 400,
  ACCOUNT_NOT_FOUND: 400,
  NO_TRUSTLINE: 400,
  TRUSTLINE_LIMIT_TOO_LOW: 400,
  INVALID_SIGNATURE: 400,
  CHALLENGE_EXPIRED: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN_ORIGIN: 403,
  NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  PAYMENT_NOT_ASSIGNABLE: 409,
  WALLET_TAKEN: 409,
  EMAIL_TAKEN: 409,
  IDEMPOTENCY_MISMATCH: 409,
  LIMIT_REACHED: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  HORIZON_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
};

export interface AppErrorOptions {
  details?: unknown[];
  /** Seconds; sent as Retry-After. */
  retryAfter?: number;
}

export class AppError extends Error {
  readonly status: number;
  readonly details: unknown[];
  readonly retryAfter?: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    opts: AppErrorOptions = {},
  ) {
    super(message);
    this.name = "AppError";
    this.status = HTTP_STATUS[code];
    this.details = opts.details ?? [];
    this.retryAfter = opts.retryAfter;
  }
}

export const notFound = (what = "Resource") => new AppError("NOT_FOUND", `${what} not found`);
