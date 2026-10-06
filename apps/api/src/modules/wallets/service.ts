import type { Wallet } from "@prisma/client";
import { ASSET_CODES, type Wallet as WalletDto } from "@paylink/shared";
import { StrKey } from "@stellar/stellar-sdk";
import { CHANNELS, notify } from "../../db/notify";
import type { AppDeps } from "../../deps";
import { resolveAsset } from "../../lib/asset";
import { AppError, notFound } from "../../lib/errors";
import { randomNonce } from "../../lib/ids";
import { checkCanReceive, parseTrustlines } from "./capability";
import * as repo from "./repo";
import { verifyWalletSignature, type SignatureInput } from "./signature";

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

    /**
     * One ACTIVE wallet per address, decided under a per-address lock:
     * - verified and active with another merchant, or removed but still owed open requests -> WALLET_TAKEN;
     * - another merchant's unverified claim never blocks (nobody can squat on an address);
     * - a verified wallet its owner removed, with no open requests left, is free again. The
     *   new merchant gets a NEW row, so the old owner's requests and payments stay theirs.
     */
    async add(merchantId: string, input: { address: string; label?: string }): Promise<Wallet> {
      assertWalletAddress(input.address);
      const taken = () => new AppError("WALLET_TAKEN", "This wallet is already registered");
      const label = input.label ?? null;
      let wallet = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.address}))`;
        const rows = await repo.findWalletsByAddress(tx, input.address);
        const mine = rows.find((r) => r.merchantId === merchantId);
        const others = rows.filter((r) => r.merchantId !== merchantId);
        if (mine && mine.deletedAt === null) throw taken();
        if (others.some((o) => o.deletedAt === null && o.verifiedAt)) throw taken();
        if (others.length > 0 && (await repo.countOpenRequests(tx, others.map((o) => o.id))) > 0) {
          throw taken();
        }
        const squatters = others.filter((o) => o.deletedAt === null); // all unverified

        if (mine) {
          // Re-adding a wallet this merchant removed: restore the row. Ownership stays
          // proven unless someone else has verified the address since.
          for (const s of squatters) await repo.retireUnverified(tx, s.id);
          const verifiedElsewhere = others.some(
            (o) => o.verifiedAt && (!mine.verifiedAt || o.verifiedAt > mine.verifiedAt),
          );
          const restored = await repo.updateWallet(tx, merchantId, mine.id, {
            deletedAt: null,
            label: label ?? mine.label,
            verifiedAt: verifiedElsewhere ? null : mine.verifiedAt,
          });
          return restored ?? mine;
        }
        // Unverified claims are retired, never transferred: a wallet row (and the payments
        // recorded on it) stays with the merchant who created it.
        for (const s of squatters) await repo.retireUnverified(tx, s.id);
        return repo.createWallet(tx, merchantId, { address: input.address, label });
      });
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
      input: { challengeId: string; signature: SignatureInput },
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
        // Same per-address lock as add(): a verification and a competing claim on the same
        // address are strictly ordered, so two merchants can never both end up holding it.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${wallet.address}))`;
        // Another merchant may have claimed the address while this one was unverified.
        if (!(await repo.findWallet(tx, merchantId, wallet.id))) throw notFound("Wallet");
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
      await prisma.merchant.updateMany({ where: { id: merchantId, defaultWalletId: wallet.id }, data: { defaultWalletId: null } });
      await announce(wallet);
    },
  };
}

export type WalletService = ReturnType<typeof createWalletService>;
