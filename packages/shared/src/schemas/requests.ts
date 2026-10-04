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
  description: z.string().nullable(),
  customerRef: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  expiresAt: z.string(),
  paidAt: z.string().nullable(),
  paidTxHash: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  /** Money arrived that the merchant should send back (overpaid, or closed with funds received). */
  refundOwed: z.boolean(),
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
  walletId: z.string(),
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
  assignedManually: z.boolean(),
  assignedAt: z.string().nullable(),
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
