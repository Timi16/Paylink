import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import type { Mailer } from "./lib/mailer";
import type { LiveHub } from "./modules/stream/hub";
import type { AccountLoader } from "./modules/wallets/horizonAccounts";

export interface Limits {
  /** Credential endpoints (signup, login, password): per IP per minute. */
  authPerMin: number;
  /** Other /auth routes (me, logout): per IP per minute. */
  authReadPerMin: number;
  publicPerMin: number;
  v1PerMin: number;
  /** Pre-auth ceiling on /v1 per IP, so bad keys can't hammer the DB. */
  v1PerIpPerMin: number;
  sseStreamsPerIp: number;
  sseStreamsPerMerchant: number;
  sseStreamsTotal: number;
}

export const DEFAULT_LIMITS: Limits = {
  authPerMin: 5,
  authReadPerMin: 60,
  publicPerMin: 60,
  v1PerMin: 300,
  v1PerIpPerMin: 1000,
  sseStreamsPerIp: 5,
  sseStreamsPerMerchant: 10,
  sseStreamsTotal: 1000,
};

export interface AppDeps {
  prisma: PrismaClient;
  accounts: AccountLoader;
  hub: LiveHub;
  logger: Logger;
  limits: Limits;
  /** null when outgoing email is not configured. */
  mailer: Mailer | null;
}
