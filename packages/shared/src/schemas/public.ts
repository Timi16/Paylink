import { z } from "zod";
import { AssetSchema, CANNOT_RECEIVE_REASONS, REQUEST_STATUSES } from "./common";

export const PublicIdParamsSchema = z
  .object({ publicId: z.string().regex(/^[A-Za-z0-9]{12}$/, "Invalid payment link") })
  .strict();

/** Everything the public checkout may see. Nothing else about the merchant leaves the API. */
export const CheckoutSchema = z.object({
  businessName: z.string(),
  /** How to reach the business, if they set one. */
  supportContact: z.string().nullable(),
  amount: z.string(),
  amountReceived: z.string(),
  amountRemaining: z.string(),
  asset: AssetSchema,
  wallet: z.string(),
  /** The business proved it controls this wallet by signing a challenge with it. */
  walletVerified: z.boolean(),
  memo: z.string(),
  memoId: z.string(),
  muxedAddress: z.string(),
  description: z.string().nullable(),
  status: z.enum(REQUEST_STATUSES),
  expiresAt: z.string(),
  paidTxHash: z.string().nullable(),
  /** Ledger close time of the payment that completed it. */
  paidAt: z.string().nullable(),
  canReceive: z.boolean(),
  cannotReceiveReason: z.enum(CANNOT_RECEIVE_REASONS).nullable(),
  sep7Uri: z.string(),
});
export type Checkout = z.infer<typeof CheckoutSchema>;

/** Payload of the public SSE `status` event. */
export const CheckoutStatusSchema = z.object({
  status: z.enum(REQUEST_STATUSES),
  amountReceived: z.string(),
  amountRemaining: z.string(),
  paidTxHash: z.string().nullable(),
  paidAt: z.string().nullable(),
  expiresAt: z.string(),
});
export type CheckoutStatus = z.infer<typeof CheckoutStatusSchema>;

export const HealthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  db: z.enum(["up", "down"]),
  network: z.literal("testnet"),
  lastProcessedLedger: z.number().nullable(),
  lagSeconds: z.number().nullable(),
  openRequests: z.number().nullable(),
});
export type Health = z.infer<typeof HealthSchema>;
