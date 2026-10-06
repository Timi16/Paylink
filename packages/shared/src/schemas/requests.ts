import { z } from "zod";
import {
  AmountSchema,
  ASSET_CODES,
  AssetSchema,
  IdSchema,
  PaginationQuery,
  PAYMENT_OUTCOMES,
  REQUEST_STATUSES,
} from "./common";

export const MIN_EXPIRY_MINUTES = 5;
export const MAX_EXPIRY_MINUTES = 43_200; // 30 days
export const DEFAULT_EXPIRY_MINUTES = 30;
const MAX_METADATA_BYTES = 4096;

export const CreateRequestBody = z
  .object({
    walletId: IdSchema,
    amount: AmountSchema,
    asset: z.enum(ASSET_CODES, {
      errorMap: () => ({ message: `Unsupported asset. Allowed: ${ASSET_CODES.join(", ")}` }),
    }),
    expiresInMinutes: z
      .number()
      .int()
      .min(MIN_EXPIRY_MINUTES)
      .max(MAX_EXPIRY_MINUTES)
      .default(DEFAULT_EXPIRY_MINUTES),
    description: z.string().trim().min(1).max(200).optional(),
    customerRef: z.string().trim().min(1).max(64).optional(),
    metadata: z
      .record(z.unknown())
      .refine(
        (v) => JSON.stringify(v).length <= MAX_METADATA_BYTES,
        `metadata must serialise to at most ${MAX_METADATA_BYTES} bytes`,
      )
      .optional(),
  })
  .strict();
export type CreateRequestBody = z.infer<typeof CreateRequestBody>;

export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\x21-\x7e]+$/, "Idempotency-Key must be 1-64 printable ASCII characters");

export const ListRequestsQuery = z
  .object({
    status: z.enum(REQUEST_STATUSES).optional(),
    walletId: IdSchema.optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    q: z.string().trim().min(1).max(64).optional(),
    ...PaginationQuery,
  })
  .strict();
export type ListRequestsQuery = z.infer<typeof ListRequestsQuery>;

export const RequestSchema = z.object({
  id: z.string(),
  publicId: z.string(),
  status: z.enum(REQUEST_STATUSES),
  walletId: z.string(),
  wallet: z.string(),
  asset: AssetSchema,
  amount: z.string(),
  amountStroops: z.string(),
  amountReceived: z.string(),
  amountReceivedStroops: z.string(),
  amountRemaining: z.string(),
  memo: z.string(),
  /** The memo as a number: usable as MEMO_ID when a text memo is not possible. */
  memoId: z.string(),
  /** Wallet + memoId as one M… address: pay here with no memo at all (contract wallets). */
  muxedAddress: z.string(),
  description: z.string().nullable(),
  customerRef: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  expiresAt: z.string(),
  paidAt: z.string().nullable(),
  paidTxHash: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  /** Set when the merchant recorded that they sent back what this request owed (excess, or money counted before it closed). */
  refundedAt: z.string().nullable(),
  /** True when `refundDue` holds an amount of at least 0.01 of some asset. */
  refundOwed: z.boolean(),
  /**
   * What to send back, per asset: any excess over the amount asked, money counted on a
   * request that closed unpaid, and payments that were not applied (duplicate, late, after
   * cancel or reset, wrong asset). `refundOwed` is true when one of these is at least 0.01;
   * smaller amounts are listed here but treated as dust.
   */
  refundDue: z.array(z.object({ asset: AssetSchema, amount: z.string(), amountStroops: z.string() })),
  createdVia: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  checkoutUrl: z.string(),
});
export type PaymentRequest = z.infer<typeof RequestSchema>;

export const PaymentSchema = z.object({
  eventId: z.string(),
  txHash: z.string(),
  innerTxHash: z.string().nullable(),
  ledger: z.number(),
  ledgerClosedAt: z.string(),
  /** Null when the payment went to another merchant's wallet (WRONG_WALLET). */
  walletId: z.string().nullable(),
  from: z.string(),
  to: z.string(),
  toMuxedId: z.string().nullable(),
  memo: z.string().nullable(),
  memoNormalized: z.string().nullable(),
  memoType: z.string(),
  asset: AssetSchema,
  amount: z.string(),
  amountStroops: z.string(),
  eventType: z.string(),
  source: z.string(),
  requestId: z.string().nullable(),
  outcome: z.enum(PAYMENT_OUTCOMES),
  /** How the payment was tied to its request: "memo", "amount" (automatic, opt-in) or "manual". */
  matchedBy: z.string().nullable(),
  /** Unmatched payments in list responses: the one open request this payment exactly settles. */
  suggestedRequestId: z.string().nullable(),
  assignedManually: z.boolean(),
  assignedAt: z.string().nullable(),
  /** Set when the merchant recorded that they sent this payment back. */
  refundedAt: z.string().nullable(),
  refundTxHash: z.string().nullable(),
  createdAt: z.string(),
});
export type ChainPayment = z.infer<typeof PaymentSchema>;

export const RequestEventSchema = z.object({
  id: z.string(),
  fromStatus: z.enum(REQUEST_STATUSES),
  toStatus: z.enum(REQUEST_STATUSES),
  reason: z.string(),
  actor: z.string(),
  paymentEventId: z.string().nullable(),
  createdAt: z.string(),
});
export type RequestEvent = z.infer<typeof RequestEventSchema>;

/** Body of the two "mark as refunded" endpoints. PayLink never sends money; this only records it. */
export const MarkRefundedBody = z
  .object({ txHash: z.string().trim().toLowerCase().regex(/^[0-9a-f]{64}$/, "A transaction hash is 64 hex characters").optional() })
  .strict();
export type MarkRefundedBody = z.infer<typeof MarkRefundedBody>;

export const RequestStatsQuery = z
  .object({
    walletId: IdSchema.optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    q: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type RequestStatsQuery = z.infer<typeof RequestStatsQuery>;

/** Counts for the status filter chips: the same filters as the list, minus status. */
export const RequestStatsResponse = z.object({ total: z.number(), byStatus: z.record(z.enum(REQUEST_STATUSES), z.number()) });
export type RequestStats = z.infer<typeof RequestStatsResponse>;

export const SummaryQuery = z.object({ from: z.string().datetime({ offset: true }) }).strict();
const AssetAmount = z.object({ asset: AssetSchema, amount: z.string(), amountStroops: z.string() });
/** GET /v1/summary: the numbers behind the dashboard overview. */
export const SummaryResponse = z.object({
  from: z.string(),
  /** Payments applied to requests since `from`, per asset. */
  collected: z.array(AssetAmount.extend({ payments: z.number() })),
  /** Requests created since `from`, and how many of those are paid. */
  requests: z.object({ created: z.number(), settled: z.number() }),
  /** Requests still open right now. */
  open: z.object({ count: z.number(), underpaid: z.number(), nextExpiresAt: z.string().nullable() }),
  needsYou: z.object({
    /** Payments waiting to be assigned or refunded. */
    unmatched: z.number(),
    /** Requests with a refund still to send. */
    refunds: z.number(),
    refundRequests: z.array(RequestSchema),
  }),
});
export type Summary = z.infer<typeof SummaryResponse>;

export const RequestResponse = z.object({ request: RequestSchema });
export const RequestCreatedResponse = z.object({ request: RequestSchema, checkoutUrl: z.string() });
export const RequestDetailResponse = z.object({
  request: RequestSchema,
  payments: z.array(PaymentSchema),
  events: z.array(RequestEventSchema),
});
export const RequestListResponse = z.object({
  data: z.array(RequestSchema),
  nextCursor: z.string().nullable(),
});
