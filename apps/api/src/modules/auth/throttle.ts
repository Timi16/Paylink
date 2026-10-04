import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../lib/errors";

const WINDOW_MS = 60 * 60_000;
const MAX_LOCK_MS = 15 * 60_000;

/** Free attempts and first lock length for each kind of counter. */
export const PAIR_RULE = { free: 2, baseMs: 2000 } as const;
export const ACCOUNT_RULE = { free: 19, baseMs: 30_000 } as const;

/** One client (IP) trying one account. Locks fast: 2, 4, 8 … seconds from the 3rd failure. */
export const pairKey = (email: string, ip: string | null) => `p:${email}|${ip ?? "unknown"}`;
/**
 * The account as a whole, across all IPs. Locks only after 20 failures in an hour, and never
 * applies to a browser that has logged in to this account before (a trusted device), so an
 * attacker who knows the email cannot lock the merchant out of their own dashboard.
 */
export const accountKey = (email: string) => `e:${email}`;
export const passwordChangeKey = (merchantId: string) => `pw:${merchantId}`;

/**
 * Growing delay after failed logins, on top of the per-IP rate limit. Stored in Postgres so
 * it holds across API instances and restarts.
 */
export class LoginThrottle {
  constructor(private readonly prisma: PrismaClient) {}

  async assertAllowed(keys: string[]): Promise<void> {
    const now = new Date();
    const locked = await this.prisma.loginThrottle.findMany({
      where: { key: { in: keys }, lockedUntil: { gt: now } },
      select: { lockedUntil: true },
    });
    if (locked.length === 0) return;
    const until = Math.max(...locked.map((l) => l.lockedUntil.getTime()));
    throw new AppError("RATE_LIMITED", "Too many failed attempts. Try again later.", {
      retryAfter: Math.max(1, Math.ceil((until - now.getTime()) / 1000)),
    });
  }

  async recordFailure(key: string, rule: { free: number; baseMs: number }): Promise<void> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - WINDOW_MS);
    // Atomic increment; a counter idle for an hour starts again from 1.
    const rows = await this.prisma.$queryRaw<{ failures: number }[]>`
      INSERT INTO "LoginThrottle" ("key", "failures", "lockedUntil", "updatedAt")
      VALUES (${key}, 1, ${now}, ${now})
      ON CONFLICT ("key") DO UPDATE SET
        "failures" = CASE WHEN "LoginThrottle"."updatedAt" < ${windowStart} THEN 1 ELSE "LoginThrottle"."failures" + 1 END,
        "updatedAt" = ${now}
      RETURNING "failures"`;
    const over = (rows[0]?.failures ?? 1) - rule.free;
    if (over <= 0) return;
    const lockMs = Math.min(rule.baseMs * 2 ** Math.min(over - 1, 20), MAX_LOCK_MS);
    await this.prisma.loginThrottle.updateMany({
      where: { key },
      data: { lockedUntil: new Date(now.getTime() + lockMs) },
    });
  }

  async clear(keys: string[]): Promise<void> {
    await this.prisma.loginThrottle.deleteMany({ where: { key: { in: keys } } });
  }
}

/** Housekeeping for the shared counters; run by the worker. */
export async function pruneCounters(prisma: PrismaClient, now: Date = new Date()): Promise<void> {
  await prisma.loginThrottle.deleteMany({ where: { updatedAt: { lt: new Date(now.getTime() - 24 * 60 * 60_000) } } });
  await prisma.rateLimit.deleteMany({ where: { resetAt: { lt: new Date(now.getTime() - 60 * 60_000) } } });
}
