import { TrustlineSchema, type CannotReceiveReason, type Trustline } from "@paylink/shared";
import { z } from "zod";
import type { AssetRef } from "../../lib/asset";
import { parseAmount } from "../../lib/amount";

export type ReceiveCheck = { ok: true } | { ok: false; reason: CannotReceiveReason };

export function parseTrustlines(json: unknown): Trustline[] {
  const parsed = z.array(TrustlineSchema).safeParse(json);
  return parsed.success ? parsed.data : [];
}

function stroops(value: string): bigint {
  // Horizon returns up to 7 decimals; tolerate fewer.
  return parseAmount(value) ?? 0n;
}

/**
 * Can this wallet receive `amountStroops` of `asset` right now?
 * XLM needs only an existing account; credit assets need an authorised trustline with
 * headroom: limit - balance - buying liabilities >= amount.
 */
export function checkCanReceive(
  wallet: { accountExists: boolean; trustlines: unknown },
  asset: AssetRef,
  amountStroops: bigint,
): ReceiveCheck {
  if (!wallet.accountExists) return { ok: false, reason: "ACCOUNT_NOT_FOUND" };
  if (asset.issuer === null) return { ok: true };
  const line = parseTrustlines(wallet.trustlines).find(
    (t) => t.code === asset.code && t.issuer === asset.issuer,
  );
  if (!line || !line.authorized) return { ok: false, reason: "NO_TRUSTLINE" };
  const headroom = stroops(line.limit) - stroops(line.balance) - stroops(line.buyingLiabilities);
  if (headroom < amountStroops) return { ok: false, reason: "TRUSTLINE_LIMIT_TOO_LOW" };
  return { ok: true };
}

export const RECEIVE_ERROR_MESSAGES: Record<CannotReceiveReason, string> = {
  ACCOUNT_NOT_FOUND: "This wallet's account does not exist on Stellar Testnet yet. Fund it first.",
  NO_TRUSTLINE: "This wallet has no trustline for the requested asset, so it cannot receive it",
  TRUSTLINE_LIMIT_TOO_LOW: "The amount exceeds what this wallet's trustline limit allows it to receive",
};
