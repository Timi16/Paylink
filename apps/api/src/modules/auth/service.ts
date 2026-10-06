import type { Merchant, Session } from "@prisma/client";
import type { Merchant as MerchantDto, Session as SessionDto, UpdateSettingsBody } from "@paylink/shared";
import argon2 from "argon2";
import { uniqueViolation } from "../../db/prisma";
import type { AppDeps } from "../../deps";
import { AppError } from "../../lib/errors";
import { generateSessionToken, hashSessionToken } from "../../lib/ids";
import { CHANNELS, notify } from "../../db/notify";
import * as repo from "./repo";
import { ACCOUNT_RULE, accountKey, LoginThrottle, PAIR_RULE, pairKey, passwordChangeKey } from "./throttle";

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** "Keep me logged in" unticked: the cookie dies with the browser, and the session within a day. */
export const SHORT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const RESET_COOLDOWN_MS = 60 * 1000;
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
    supportContact: m.supportContact,
    defaultWalletId: m.defaultWalletId,
    defaultExpiryMinutes: m.defaultExpiryMinutes,
    autoMatchByAmount: m.autoMatchByAmount,
    createdAt: m.createdAt.toISOString(),
  };
}

export function serializeSession(s: Session, currentId: string): SessionDto {
  return {
    id: s.id,
    current: s.id === currentId,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    ip: s.ip,
    userAgent: s.userAgent,
  };
}

export function createAuthService(deps: AppDeps) {
  const { prisma } = deps;
  const throttle = new LoginThrottle(prisma);
  // Verified against when the email is unknown, so both failure paths cost the same time.
  const dummyHash = argon2.hash("paylink-dummy-password", ARGON_OPTIONS);

  async function startSession(merchantId: string, client: ClientInfo, ttlMs = SESSION_TTL_MS): Promise<string> {
    const token = generateSessionToken();
    await repo.createSession(prisma, merchantId, {
      id: hashSessionToken(token),
      expiresAt: new Date(Date.now() + ttlMs),
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
    async updateSettings(merchantId: string, input: UpdateSettingsBody): Promise<Merchant> {
      if (input.defaultWalletId) {
        const wallet = await prisma.wallet.findFirst({
          where: { id: input.defaultWalletId, merchantId, deletedAt: null },
          select: { id: true },
        });
        if (!wallet) throw new AppError("NOT_FOUND", "Wallet not found");
      }
      const merchant = await prisma.merchant.update({ where: { id: merchantId }, data: input });
      if (input.autoMatchByAmount !== undefined) {
        // The worker caches this flag with its watched wallets; tell it to reload.
        await notify(prisma, CHANNELS.walletsChanged, { walletId: "", merchantId }).catch(() => undefined);
      }
      return merchant;
    },

    listSessions(merchantId: string): Promise<Session[]> {
      return prisma.session.findMany({
        where: { merchantId, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
    },

    /** Signs one of the merchant's other sessions out. Returns false if it is not theirs. */
    async revokeSession(merchantId: string, sessionId: string): Promise<boolean> {
      const deleted = await prisma.session.deleteMany({ where: { id: sessionId, merchantId } });
      return deleted.count > 0;
    },

    async revokeOtherSessions(merchantId: string, keepSessionId: string): Promise<void> {
      await repo.deleteOtherSessions(prisma, merchantId, keepSessionId);
    },

    /**
     * Emails a one-hour reset link. Always succeeds from the caller's point of view, whether
     * or not the email has an account, so it cannot be used to find out who is a customer.
     */
    async forgotPassword(email: string, webOrigin: string): Promise<void> {
      if (!deps.mailer) {
        throw new AppError("SERVICE_UNAVAILABLE", "Password reset by email isn't set up on this server yet");
      }
      const merchant = await repo.findMerchantByEmail(prisma, email);
      if (!merchant) return;
      const latest = await prisma.passwordReset.findFirst({
        where: { merchantId: merchant.id },
        orderBy: { createdAt: "desc" },
      });
      // One email a minute per account, however many times the form is submitted.
      if (latest && Date.now() - latest.createdAt.getTime() < RESET_COOLDOWN_MS) return;
      const token = generateSessionToken();
      await prisma.passwordReset.create({
        data: { id: hashSessionToken(token), merchantId: merchant.id, expiresAt: new Date(Date.now() + RESET_TTL_MS) },
      });
      const link = `${webOrigin}/reset-password?token=${token}`;
      await deps.mailer
        .send({
          to: merchant.email,
          subject: "Reset your PayLink password",
          text: [
            `Hi ${merchant.businessName},`,
            "",
            "Use this link to choose a new PayLink password. It works once, for one hour:",
            link,
            "",
            "If you didn't ask for this, ignore this email. Your password stays the same.",
          ].join("\n"),
        })
        .catch((err: unknown) => deps.logger.error({ err }, "password reset email failed to send"));
    },

    /** Sets a new password from an emailed link and signs the merchant out everywhere. */
    async resetPassword(token: string, newPassword: string): Promise<void> {
      const id = hashSessionToken(token);
      const passwordHash = await argon2.hash(newPassword, ARGON_OPTIONS);
      await prisma.$transaction(async (tx) => {
        // Single use, enforced atomically.
        const used = await tx.passwordReset.updateMany({
          where: { id, usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() },
        });
        if (used.count === 0) {
          throw new AppError("CHALLENGE_EXPIRED", "This reset link has expired or was already used. Ask for a new one.");
        }
        const reset = await tx.passwordReset.findUniqueOrThrow({ where: { id } });
        const merchant = await tx.merchant.update({ where: { id: reset.merchantId }, data: { passwordHash } });
        await tx.session.deleteMany({ where: { merchantId: reset.merchantId } });
        await tx.passwordReset.deleteMany({ where: { merchantId: reset.merchantId, id: { not: id } } });
        await tx.loginThrottle.deleteMany({ where: { key: accountKey(merchant.email) } });
      });
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
      remember = true,
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
        token: await startSession(merchant.id, client, remember ? SESSION_TTL_MS : SHORT_SESSION_TTL_MS),
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
