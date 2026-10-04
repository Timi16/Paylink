import { Networks, StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

export const TESTNET_PASSPHRASE = Networks.TESTNET; // "Test SDF Network ; September 2015"

const url = z.string().url();

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  // Loopback by default: the API sits behind a reverse proxy on the same machine. Reached
  // directly, a client could forge X-Forwarded-For and dodge the per-IP rate limits.
  HOST: z.string().min(1).default("127.0.0.1"),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgresql:// URL"),
  STELLAR_RPC_URL: url,
  HORIZON_URL: url,
  // Testnet only: PayLink refuses to boot against any other network.
  NETWORK_PASSPHRASE: z.literal(TESTNET_PASSPHRASE, {
    errorMap: () => ({ message: `must be the testnet passphrase "${TESTNET_PASSPHRASE}"` }),
  }),
  USDC_ISSUER: z
    .string()
    .refine((v) => StrKey.isValidEd25519PublicKey(v), "must be a valid G address"),
  WEB_ORIGIN: url.refine((v) => new URL(v).origin === v, "must be an origin with no path or trailing slash"),
  SESSION_SECRET: z
    .string()
    .regex(/^[0-9a-fA-F]+$/, "must be hex")
    .min(64, "must be at least 32 bytes (64 hex chars)"),
  ALERT_TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  ALERT_TELEGRAM_CHAT_ID: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});
export type Env = z.infer<typeof EnvSchema>;

export class EnvError extends Error {}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Empty strings (e.g. `FOO=` in a .env file) count as unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new EnvError(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

function loadOrExit(): Env {
  try {
    return loadEnv();
  } catch (err) {
    if (err instanceof EnvError && !process.env.VITEST) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

export const env: Env = loadOrExit();
export const isProduction = env.NODE_ENV === "production";
