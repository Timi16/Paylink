import type { Checkout } from "@paylink/shared";
import { env } from "../../config/env";
import type { AppDeps } from "../../deps";
import { formatStroops } from "../../lib/amount";
import { notFound } from "../../lib/errors";
import { remainingStroops } from "../requests/serialize";
import { OPEN_STATUSES } from "../transitions";
import { checkCanReceive } from "../wallets/capability";
import type { WalletService } from "../wallets/service";

const CHECKOUT_WALLET_MAX_AGE_MS = 30_000;

/** SEP-7 pay URI for the QR code and "open in wallet" links. */
export function sep7Uri(r: {
  walletAddress: string;
  assetCode: string;
  assetIssuer: string | null;
  memo: string;
  amountStroops: bigint;
}): string {
  const params = new URLSearchParams();
  params.set("destination", r.walletAddress);
  params.set("amount", formatStroops(r.amountStroops));
  if (r.assetIssuer !== null) {
    params.set("asset_code", r.assetCode);
    params.set("asset_issuer", r.assetIssuer);
  }
  params.set("memo", r.memo);
  params.set("memo_type", "MEMO_TEXT");
  params.set("network_passphrase", env.NETWORK_PASSPHRASE);
  // SEP-7 wants percent-encoding (%20), not form encoding (+).
  return `web+stellar:pay?${params.toString().replace(/\+/g, "%20")}`;
}

export function createPublicService(deps: AppDeps, wallets: WalletService) {
  const { prisma } = deps;
  return {
    async findRequest(publicId: string) {
      const request = await prisma.paymentRequest.findUnique({ where: { publicId } });
      if (!request) throw notFound("Payment request");
      return request;
    },

    /** Only the fields the checklist allows on a public page. */
    async checkout(publicId: string): Promise<Checkout> {
      const request = await prisma.paymentRequest.findUnique({
        where: { publicId },
        include: { merchant: { select: { businessName: true } }, wallet: true },
      });
      if (!request) throw notFound("Payment request");

      const remaining = remainingStroops(request);
      const open = OPEN_STATUSES.includes(request.status);
      let canReceive = true;
      let reason: Checkout["cannotReceiveReason"] = null;
      if (open) {
        // Re-check the wallet on checkout load (cached 30 s) so the payer is warned before
        // sending money the wallet cannot accept. Never fails the page if Horizon is down.
        const wallet = await wallets
          .ensureFresh(request.wallet, CHECKOUT_WALLET_MAX_AGE_MS)
          .catch(() => request.wallet);
        const check = checkCanReceive(
          wallet,
          { code: request.assetCode, issuer: request.assetIssuer },
          remaining,
        );
        if (!check.ok) {
          canReceive = false;
          reason = check.reason;
        }
      }

      return {
        businessName: request.merchant.businessName,
        amount: formatStroops(request.amountStroops),
        amountReceived: formatStroops(request.receivedStroops),
        amountRemaining: formatStroops(remaining),
        asset: { code: request.assetCode, issuer: request.assetIssuer },
        wallet: request.walletAddress,
        memo: request.memo,
        description: request.description,
        status: request.status,
        expiresAt: request.expiresAt.toISOString(),
        paidTxHash: request.paidTxHash,
        canReceive,
        cannotReceiveReason: reason,
        sep7Uri: sep7Uri({ ...request, amountStroops: remaining > 0n ? remaining : request.amountStroops }),
      };
    },
  };
}

export type PublicService = ReturnType<typeof createPublicService>;
