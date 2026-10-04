import type { Merchant } from "@prisma/client";
import type { Merchant as MerchantDto } from "@paylink/shared";
import argon2 from "argon2";
import { uniqueViolation } from "../../db/prisma";
import type { AppDeps } from "../../deps";
import { AppError } from "../../lib/errors";
import { generateSessionToken, hashSessionToken } from "../../lib/ids";
import * as repo from "./repo";

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
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
    createdAt: m.createdAt.toISOString(),
  };
}

/**
 * Growing per-account delay after failed logins (on top of the per-IP limit): from the 3rd
 * consecutive failure the account is locked for 2, 4, 8 … seconds, capped at 15 minutes.
 * In memory: PayLink runs a single API instance by design.
 */
export class LoginThrottle {
  private readonly entries = new Map<string, { failures: number; lockedUntil: number }>();

  assertAllowed(email: string): void {
    const entry = this.entries.get(email);
    if (entry && entry.lockedUntil > Date.now()) {
      const retryAfter = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
      throw new AppError("RATE_LIMITED", "Too many failed attempts. Try again later.", { retryAfter });
    }
  }

  recordFailure(email: string): void {
    if (this.entries.size > 10_000) this.prune();
    const failures = (this.entries.get(email)?.failures ?? 0) + 1;
    const delayMs = failures >= 3 ? Math.min(1000 * 2 ** (failures - 2), 15 * 60_000) : 0;
    this.entries.set(email, { failures, lockedUntil: Date.now() + delayMs });
  }

  recordSuccess(email: string): void {
    this.entries.delete(email);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil + 15 * 60_000 < now) this.entries.delete(key);
    }
    if (this.entries.size > 10_000) this.entries.clear();
  }
}

export function createAuthService(deps: AppDeps) {
  const { prisma } = deps;
  const throttle = new LoginThrottle();
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

  return {
    async signup(
      input: { email: string; password: string; businessName: string },
      client: ClientInfo,
    ): Promise<{ merchant: Merchant; token: string }> {
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
      return { merchant, token: await startSession(merchant.id, client) };
    },

    /** `oldToken` is the cookie presented with the login, if any: it is rotated away. */
    async login(
      input: { email: string; password: string },
      client: ClientInfo,
      oldToken: string | null,
    ): Promise<{ merchant: Merchant; token: string }> {
      throttle.assertAllowed(input.email);
      const merchant = await repo.findMerchantByEmail(prisma, input.email);
      const hash = merchant?.passwordHash ?? (await dummyHash);
      const ok = await argon2.verify(hash, input.password).catch(() => false);
      if (!merchant || !ok) {
        throttle.recordFailure(input.email);
        // Same error whether the email or the password was wrong.
        throw new AppError("INVALID_CREDENTIALS", "Incorrect email or password");
      }
      throttle.recordSuccess(input.email);
      if (oldToken) await repo.deleteSession(prisma, hashSessionToken(oldToken));
      await repo.deleteExpiredSessions(prisma, merchant.id);
      return { merchant, token: await startSession(merchant.id, client) };
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
      throttle.assertAllowed(merchant.email);
      const ok = await argon2.verify(merchant.passwordHash, input.currentPassword).catch(() => false);
      if (!ok) {
        throttle.recordFailure(merchant.email);
        throw new AppError("INVALID_CREDENTIALS", "Current password is incorrect");
      }
      const passwordHash = await argon2.hash(input.newPassword, ARGON_OPTIONS);
      await prisma.$transaction([
        prisma.merchant.update({ where: { id: merchantId }, data: { passwordHash } }),
        prisma.session.deleteMany({ where: { merchantId, id: { not: sessionId } } }),
      ]);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
