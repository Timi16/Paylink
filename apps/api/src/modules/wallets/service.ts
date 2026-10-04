import type { Wallet } from "@prisma/client";
import { ASSET_CODES, type Wallet as WalletDto } from "@paylink/shared";
import { StrKey } from "@stellar/stellar-sdk";
import { CHANNELS, notify } from "../../db/notify";
import { uniqueViolation } from "../../db/prisma";
import type { AppDeps } from "../../deps";
import { resolveAsset } from "../../lib/asset";
import { AppError, notFound } from "../../lib/errors";
import { randomNonce } from "../../lib/ids";
import { checkCanReceive, parseTrustlines } from "./capability";
import * as repo from "./repo";
import { verifyWalletSignature } from "./signature";

const CHALLENGE_TTL_MS = 10 * 60_000;

export function serializeWallet(w: Wallet): WalletDto {
  const canReceive: WalletDto["canReceive"] = {};
  for (const code of ASSET_CODES) {
    // Amount 1 stroop: "can it receive this asset at all?"
    const check = checkCanReceive(w, resolveAsset(code), 1n);
    canReceive[code] = check.ok
      ? { canReceive: true, reason: null }
      : { canReceive: false, reason: check.reason };
  }
  return {
    id: w.id,
    address: w.address,
    label: w.label,
    verified: w.verifiedAt !== null,
    verifiedAt: w.verifiedAt?.toISOString() ?? null,
    accountExists: w.accountExists,
    trustlines: parseTrustlines(w.trustlines),
    canReceive,
    checkedAt: w.checkedAt?.toISOString() ?? null,
    createdAt: w.createdAt.toISOString(),
  };
}

/** Rejects anything that is not a plain G address. A pasted secret is never echoed or stored. */
export function assertWalletAddress(address: string): void {
  if (/^S[A-Z2-7]{55}$/.test(address) || StrKey.isValidEd25519SecretSeed(address)) {
    throw new AppError(
      "SECRET_KEY_REJECTED",
      "That is a secret key (S…). Never share it. Paste the wallet's public address (G…) instead.",
    );
  }
  if (StrKey.isValidMed25519PublicKey(address)) {
    throw new AppError("VALIDATION_FAILED", "Muxed (M…) addresses are not supported; use the base G… address", {
      details: [{ path: "address", message: "Muxed addresses are not supported" }],
    });
  }
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new AppError("VALIDATION_FAILED", "Not a valid Stellar public address (G…)", {
      details: [{ path: "address", message: "Invalid Stellar address" }],
    });
  }
}

export function createWalletService(deps: AppDeps) {
  const { prisma, accounts } = deps;
  const inFlight = new Map<string, Promise<Wallet>>();

  async function announce(wallet: Wallet): Promise<void> {
    await notify(prisma, CHANNELS.walletsChanged, {
      walletId: wallet.id,
      merchantId: wallet.merchantId,
    }).catch((err: unknown) => deps.logger.warn({ err }, "wallets_changed notify failed"));
  }

  /** Reads the account from Horizon and caches existence + trustlines on the wallet. */
  function refresh(wallet: Wallet): Promise<Wallet> {
    const running = inFlight.get(wallet.id);
    if (running) return running; // one Horizon call per wallet at a time
    const task = (async () => {
      const state = await accounts.load(wallet.address);
      const updated = await repo.updateWallet(prisma, wallet.merchantId, wallet.id, {
        accountExists: state.exists,
        trustlines: state.exists ? state.trustlines : [],
        checkedAt: new Date(),
      });
      return updated ?? wallet;
    })().finally(() => inFlight.delete(wallet.id));
    inFlight.set(wallet.id, task);
    return task;
  }

  /**
   * Returns the wallet with Horizon data no older than maxAgeMs. If Horizon is down, stale
   * data is used when there is some; with none at all the error propagates.
   */
  async function ensureFresh(wallet: Wallet, maxAgeMs: number): Promise<Wallet> {
    if (wallet.checkedAt && Date.now() - wallet.checkedAt.getTime() <= maxAgeMs) return wallet;
    try {
      return await refresh(wallet);
    } catch (err) {
      if (wallet.checkedAt) {
        deps.logger.warn({ walletId: wallet.id }, "wallet check failed; using cached data");
        return wallet;
      }
      throw err;
    }
  }

  async function getOwned(merchantId: string, id: string): Promise<Wallet> {
    const wallet = await repo.findWallet(prisma, merchantId, id);
    if (!wallet) throw notFound("Wallet");
    return wallet;
  }

  return {
    ensureFresh,

    async list(merchantId: string): Promise<Wallet[]> {
      return repo.listWallets(prisma, merchantId);
    },

    async add(merchantId: string, input: { address: string; label?: string }): Promise<Wallet> {
      assertWalletAddress(input.address);
      const existing = await repo.findWalletByAddress(prisma, input.address);
      let wallet: Wallet;
      if (existing && existing.merchantId !== merchantId) {
        // Another merchant registered this address. If they never proved ownership, the
        // claim is worthless: let this merchant take it, so nobody can squat on an address
        // they don't own. A verified wallet (even a removed one) stays with its owner.
        const taken = !existing.verifiedAt && (await repo.takeOverUnverified(prisma, merchantId, existing.id, input.label ?? null));
        if (!taken) throw new AppError("WALLET_TAKEN", "This wallet is already registered");
        wallet = (await repo.findWallet(prisma, merchantId, existing.id)) ?? existing;
      } else if (existing) {
        if (existing.deletedAt === null) {
          throw new AppError("WALLET_TAKEN", "This wallet is already registered");
        }
        // The same merchant re-adding a wallet they removed: restore it. Ownership was
        // already proven, so verifiedAt is kept.
        const restored = await repo.updateWallet(prisma, merchantId, existing.id, {
          deletedAt: null,
          label: input.label ?? existing.label,
        });
        wallet = restored ?? existing;
      } else {
        try {
          wallet = await repo.createWallet(prisma, merchantId, {
            address: input.address,
            label: input.label ?? null,
          });
        } catch (err) {
          if (uniqueViolation(err)) throw new AppError("WALLET_TAKEN", "This wallet is already registered");
          throw err;
        }
      }
      // Best effort: the wallet is still added if Horizon is unreachable right now.
      wallet = await refresh(wallet).catch(() => wallet);
      await announce(wallet);
      return wallet;
    },

    async refresh(merchantId: string, id: string): Promise<Wallet> {
      const wallet = await refresh(await getOwned(merchantId, id));
      await announce(wallet);
      return wallet;
    },

    async createChallenge(merchantId: string, id: string) {
      const wallet = await getOwned(merchantId, id);
      const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
      const message = [
        "PayLink wallet verification",
        `Merchant: ${merchantId}`,
        `Wallet: ${wallet.address}`,
        `Nonce: ${randomNonce()}`,
        `Expires: ${expiresAt.toISOString()}`,
      ].join("\n");
      const challenge = await prisma.walletChallenge.create({
        data: { merchantId, address: wallet.address, message, expiresAt },
      });
      return { challengeId: challenge.id, message, expiresAt: expiresAt.toISOString() };
    },

    async verify(
      merchantId: string,
      id: string,
      input: { challengeId: string; signature: string },
    ): Promise<Wallet> {
      const wallet = await getOwned(merchantId, id);
      const challenge = await prisma.walletChallenge.findFirst({
        where: { id: input.challengeId, merchantId, address: wallet.address },
      });
      if (!challenge) throw notFound("Challenge");
      if (challenge.usedAt || challenge.expiresAt.getTime() <= Date.now()) {
        throw new AppError("CHALLENGE_EXPIRED", "This challenge has expired or was already used. Request a new one.");
      }
      if (!verifyWalletSignature(wallet.address, challenge.message, input.signature)) {
        throw new AppError("INVALID_SIGNATURE", "The signature does not match this wallet");
      }
      const verified = await prisma.$transaction(async (tx) => {
        // Single use, enforced atomically: two concurrent verifies cannot both consume it.
        const used = await tx.walletChallenge.updateMany({
          where: { id: challenge.id, usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() },
        });
        if (used.count === 0) {
          throw new AppError("CHALLENGE_EXPIRED", "This challenge has expired or was already used. Request a new one.");
        }
        const updated = await repo.updateWallet(tx, merchantId, wallet.id, {
          verifiedAt: wallet.verifiedAt ?? new Date(),
        });
        if (!updated) throw notFound("Wallet"); // rolls the challenge back too
        return updated;
      });
      // Null means the wallet changed hands mid-verification; the transaction rolled nothing
      // forward for this merchant.
      if (!verified) throw notFound("Wallet");
      await announce(verified);
      return verified;
    },

    /** Soft delete. The worker keeps watching it until its open requests close. */
    async remove(merchantId: string, id: string): Promise<void> {
      const wallet = await getOwned(merchantId, id);
      await repo.updateWallet(prisma, merchantId, wallet.id, { deletedAt: new Date() });
      await announce(wallet);
    },
  };
}

export type WalletService = ReturnType<typeof createWalletService>;
