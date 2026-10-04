import type { Merchant } from "@prisma/client";
import type { Merchant as MerchantDto } from "@paylink/shared";
import argon2 from "argon2";
import { uniqueViolation } from "../../db/prisma";
import type { AppDeps } from "../../deps";
import { AppError } from "../../lib/errors";
import { generateSessionToken, hashSessionToken } from "../../lib/ids";
import { CHANNELS, notify } from "../../db/notify";
import * as repo from "./repo";
import { ACCOUNT_RULE, accountKey, LoginThrottle, PAIR_RULE, pairKey, passwordChangeKey } from "./throttle";

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_DEVICES = 20;
const ARGON_OPTIONS = { type: argon2.argon2id } as const;

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export function serializeMerchant(m: Merchant): MerchantDto {
  return {
    id: m.id,
    email: m.email,
    businessName: m.businessName,
    autoMatchByAmount: m.autoMatchByAmount,
    createdAt: m.createdAt.toISOString(),
  };
}

export function createAuthService(deps: AppDeps) {
  const { prisma } = deps;
  const throttle = new LoginThrottle(prisma);
  // Verified against when the email is unknown, so both failure paths cost the same time.
  const dummyHash = argon2.hash("paylink-dummy-password", ARGON_OPTIONS);

  async function startSession(merchantId: string, client: ClientInfo): Promise<string> {
    const token = generateSessionToken();
    await repo.createSession(prisma, merchantId, {
      id: hashSessionToken(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      ip: client.ip,
      userAgent: client.userAgent?.slice(0, 256) ?? null,
    });
    return token;
  }

  async function isTrustedDevice(deviceToken: string, email: string): Promise<boolean> {
    if (deviceToken.length > 128) return false;
    const device = await prisma.trustedDevice.findUnique({
      where: { id: hashSessionToken(deviceToken) },
      select: { merchant: { select: { email: true } } },
    });
    return device?.merchant.email === email;
  }

  /** Marks this browser as one that has logged in to the account; returns its cookie token. */
  async function trustDevice(merchantId: string, existingToken: string | null): Promise<string> {
    if (existingToken) {
      await prisma.trustedDevice.updateMany({
        where: { id: hashSessionToken(existingToken), merchantId },
        data: { lastUsedAt: new Date() },
      });
      return existingToken;
    }
    const token = generateSessionToken();
    await prisma.trustedDevice.create({ data: { id: hashSessionToken(token), merchantId } });
    const stale = await prisma.trustedDevice.findMany({
      where: { merchantId },
      orderBy: { lastUsedAt: "desc" },
      skip: MAX_DEVICES,
      select: { id: true },
    });
    if (stale.length > 0) {
      await prisma.trustedDevice.deleteMany({ where: { id: { in: stale.map((d) => d.id) } } });
    }
    return token;
  }

  return {
    async updateSettings(merchantId: string, input: { autoMatchByAmount: boolean }): Promise<Merchant> {
      const merchant = await prisma.merchant.update({ where: { id: merchantId }, data: input });
      // The worker caches this flag with its watched wallets; tell it to reload.
      await notify(prisma, CHANNELS.walletsChanged, { walletId: "", merchantId }).catch(() => undefined);
      return merchant;
    },

    async signup(
      input: { email: string; password: string; businessName: string },
      client: ClientInfo,
    ): Promise<{ merchant: Merchant; token: string; deviceToken: string }> {
      const passwordHash = await argon2.hash(input.password, ARGON_OPTIONS);
      let merchant: Merchant;
      try {
        merchant = await repo.createMerchant(prisma, {
          email: input.email,
          passwordHash,
          businessName: input.businessName,
        });
      } catch (err) {
        if (uniqueViolation(err)) {
          throw new AppError("EMAIL_TAKEN", "An account with this email already exists");
        }
        throw err;
      }
      return {
        merchant,
        token: await startSession(merchant.id, client),
        deviceToken: await trustDevice(merchant.id, null),
      };
    },

    /**
     * `oldToken` is the session cookie presented with the login, if any: it is rotated away.
     * `deviceToken` is the trusted-device cookie, if any.
     */
    async login(
      input: { email: string; password: string },
      client: ClientInfo,
      oldToken: string | null,
      deviceToken: string | null,
    ): Promise<{ merchant: Merchant; token: string; deviceToken: string }> {
      const pair = pairKey(input.email, client.ip);
      const account = accountKey(input.email);
      // A browser that has logged in to this account before is not subject to the
      // account-wide lock (only to its own), so failed attempts by others cannot lock it out.
      const trusted = deviceToken ? await isTrustedDevice(deviceToken, input.email) : false;
      await throttle.assertAllowed(trusted ? [pair] : [pair, account]);

      const merchant = await repo.findMerchantByEmail(prisma, input.email);
      const hash = merchant?.passwordHash ?? (await dummyHash);
      const ok = await argon2.verify(hash, input.password).catch(() => false);
      if (!merchant || !ok) {
        await throttle.recordFailure(pair, PAIR_RULE);
        await throttle.recordFailure(account, ACCOUNT_RULE);
        // Same error whether the email or the password was wrong.
        throw new AppError("INVALID_CREDENTIALS", "Incorrect email or password");
      }
      await throttle.clear([pair, account]);
      if (oldToken) await repo.deleteSession(prisma, hashSessionToken(oldToken));
      await repo.deleteExpiredSessions(prisma, merchant.id);
      return {
        merchant,
        token: await startSession(merchant.id, client),
        deviceToken: await trustDevice(merchant.id, trusted ? deviceToken : null),
      };
    },

    async logout(sessionId: string): Promise<void> {
      await repo.deleteSession(prisma, sessionId);
    },

    async me(merchantId: string): Promise<Merchant> {
      const merchant = await repo.findMerchant(prisma, merchantId);
      if (!merchant) throw new AppError("UNAUTHENTICATED", "Authentication required");
      return merchant;
    },

    async changePassword(
      merchantId: string,
      sessionId: string,
      input: { currentPassword: string; newPassword: string },
    ): Promise<void> {
      const merchant = await repo.findMerchant(prisma, merchantId);
      if (!merchant) throw new AppError("UNAUTHENTICATED", "Authentication required");
      // Keyed by the signed-in merchant: only they can trip it, and it cannot block logins.
      const key = passwordChangeKey(merchantId);
      await throttle.assertAllowed([key]);
      const ok = await argon2.verify(merchant.passwordHash, input.currentPassword).catch(() => false);
      if (!ok) {
        await throttle.recordFailure(key, PAIR_RULE);
        throw new AppError("INVALID_CREDENTIALS", "Current password is incorrect");
      }
      await throttle.clear([key]);
      const passwordHash = await argon2.hash(input.newPassword, ARGON_OPTIONS);
      await prisma.$transaction([
        prisma.merchant.update({ where: { id: merchantId }, data: { passwordHash } }),
        prisma.session.deleteMany({ where: { merchantId, id: { not: sessionId } } }),
      ]);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
