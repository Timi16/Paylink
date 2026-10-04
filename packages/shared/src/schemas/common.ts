import { z } from "zod";
import { parseAmount } from "../amount";

export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "SECRET_KEY_REJECTED",
  "WALLET_NOT_VERIFIED",
  "ACCOUNT_NOT_FOUND",
  "NO_TRUSTLINE",
  "TRUSTLINE_LIMIT_TOO_LOW",
  "INVALID_SIGNATURE",
  "CHALLENGE_EXPIRED",
  "UNAUTHENTICATED",
  "INVALID_CREDENTIALS",
  "FORBIDDEN_ORIGIN",
  "NOT_FOUND",
  "INVALID_TRANSITION",
  "PAYMENT_NOT_ASSIGNABLE",
  "WALLET_TAKEN",
  "EMAIL_TAKEN",
  "IDEMPOTENCY_MISMATCH",
  "LIMIT_REACHED",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "INTERNAL",
  "HORIZON_UNAVAILABLE",
  "SERVICE_UNAVAILABLE",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const REQUEST_STATUSES = [
  "PENDING",
  "UNDERPAID",
  "PAID",
  "OVERPAID",
  "EXPIRED",
  "CANCELLED",
  "NETWORK_RESET",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const OPEN_STATUSES = ["PENDING", "UNDERPAID"] as const satisfies readonly RequestStatus[];

export const PAYMENT_OUTCOMES = [
  "COUNTED",
  "DUPLICATE",
  "LATE",
  "AFTER_CANCEL",
  "WRONG_ASSET",
  "WRONG_ISSUER",
  "WRONG_WALLET",
  "NO_MEMO",
  "UNKNOWN_MEMO",
  "MEMO_TYPE_MISMATCH",
  "AFTER_RESET",
] as const;
export type PaymentOutcome = (typeof PAYMENT_OUTCOMES)[number];
/** Outcomes a merchant may assign to a request by hand. */
export const UNMATCHED_OUTCOMES = [
  "NO_MEMO",
  "UNKNOWN_MEMO",
  "MEMO_TYPE_MISMATCH",
] as const satisfies readonly PaymentOutcome[];

export const ASSET_CODES = ["USDC", "XLM"] as const;
export type AssetCode = (typeof ASSET_CODES)[number];

export const CANNOT_RECEIVE_REASONS = [
  "ACCOUNT_NOT_FOUND",
  "NO_TRUSTLINE",
  "TRUSTLINE_LIMIT_TOO_LOW",
] as const;
export type CannotReceiveReason = (typeof CANNOT_RECEIVE_REASONS)[number];

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.array(z.unknown()),
    requestId: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** Decimal string, up to 12 integer digits and 7 decimals, > 0, fits in int64 stroops. */
export const AmountSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,7})?$/, "Amount must be a decimal string with at most 7 decimals")
  .refine((v) => {
    const s = parseAmount(v);
    return s !== null && s > 0n;
  }, "Amount must be greater than 0 and at most 922337203685.4775807");

export const IdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid id");

export const IdParamsSchema = z.object({ id: IdSchema }).strict();

export const PaginationQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
};

export const AssetSchema = z.object({ code: z.string(), issuer: z.string().nullable() });
export const IsoDate = z.string().datetime();
