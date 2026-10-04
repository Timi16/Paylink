import { z } from "zod";
import { CANNOT_RECEIVE_REASONS, IdSchema } from "./common";

export const AddWalletBody = z
  .object({
    address: z.string().trim().min(1).max(100),
    label: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type AddWalletBody = z.infer<typeof AddWalletBody>;

export const VerifyWalletBody = z
  .object({ challengeId: IdSchema, signature: z.string().trim().min(1).max(256) })
  .strict();
export type VerifyWalletBody = z.infer<typeof VerifyWalletBody>;

export const TrustlineSchema = z.object({
  code: z.string(),
  issuer: z.string(),
  limit: z.string(),
  balance: z.string(),
  buyingLiabilities: z.string(),
  authorized: z.boolean(),
});
export type Trustline = z.infer<typeof TrustlineSchema>;

export const ReceiveCheckSchema = z.object({
  canReceive: z.boolean(),
  reason: z.enum(CANNOT_RECEIVE_REASONS).nullable(),
});

export const WalletSchema = z.object({
  id: z.string(),
  address: z.string(),
  label: z.string().nullable(),
  verified: z.boolean(),
  verifiedAt: z.string().nullable(),
  accountExists: z.boolean(),
  trustlines: z.array(TrustlineSchema),
  canReceive: z.record(ReceiveCheckSchema),
  checkedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Wallet = z.infer<typeof WalletSchema>;
export const WalletResponse = z.object({ wallet: WalletSchema });
export const WalletListResponse = z.object({ data: z.array(WalletSchema) });
export const ChallengeResponse = z.object({
  challengeId: z.string(),
  message: z.string(),
  expiresAt: z.string(),
});
export type ChallengeResponse = z.infer<typeof ChallengeResponse>;
