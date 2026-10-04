import type { PrismaClient } from "@prisma/client";
import type { ClientRateLimitInfo, Options, Store } from "express-rate-limit";

/**
 * Fixed-window rate-limit counters in Postgres, for limits that must hold no matter how many
 * API instances run (the credential endpoints). High-volume limiters stay in memory.
 */
export class PgRateLimitStore implements Store {
  /** Counters are shared, not per process. */
  localKeys = false;
  private windowMs = 60_000;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly keyPrefix: string,
  ) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const now = new Date();
    const reset = new Date(now.getTime() + this.windowMs);
    const rows = await this.prisma.$queryRaw<{ hits: number; resetAt: Date }[]>`
      INSERT INTO "RateLimit" ("key", "hits", "resetAt") VALUES (${this.keyPrefix + key}, 1, ${reset})
      ON CONFLICT ("key") DO UPDATE SET
        "hits" = CASE WHEN "RateLimit"."resetAt" <= ${now} THEN 1 ELSE "RateLimit"."hits" + 1 END,
        "resetAt" = CASE WHEN "RateLimit"."resetAt" <= ${now} THEN ${reset} ELSE "RateLimit"."resetAt" END
      RETURNING "hits", "resetAt"`;
    const row = rows[0];
    return { totalHits: row?.hits ?? 1, resetTime: row?.resetAt ?? reset };
  }

  async decrement(key: string): Promise<void> {
    await this.prisma.rateLimit.updateMany({
      where: { key: this.keyPrefix + key, hits: { gt: 0 } },
      data: { hits: { decrement: 1 } },
    });
  }

  async resetKey(key: string): Promise<void> {
    await this.prisma.rateLimit.deleteMany({ where: { key: this.keyPrefix + key } });
  }
}
