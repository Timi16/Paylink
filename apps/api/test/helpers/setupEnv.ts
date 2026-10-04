import { inject } from "vitest";

// Runs before each test file imports application code, so config/env.ts sees these.
export const TEST_WEB_ORIGIN = "https://paylink.test";

Object.assign(process.env, {
  NODE_ENV: "test",
  PORT: "4100",
  DATABASE_URL: inject("databaseUrl"),
  STELLAR_RPC_URL: "http://127.0.0.1:1/rpc",
  HORIZON_URL: "http://127.0.0.1:1",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  USDC_ISSUER: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  WEB_ORIGIN: TEST_WEB_ORIGIN,
  SESSION_SECRET: "ab".repeat(32),
  LOG_LEVEL: "silent",
});
