import { env } from "./config/env";
import { CHANNELS, PgListener } from "./db/notify";
import { isDbUnavailable, prisma } from "./db/prisma";
import { createAlerter } from "./engine/alerter";
import { SWEEP_INTERVAL_MS, sweepExpired } from "./engine/expirySweeper";
import { Ingestion } from "./engine/ingestion";
import { RECONCILE_INTERVAL_MS, reconcile } from "./engine/reconciliation";
import { HorizonBackfillSource } from "./engine/sources/horizonBackfill";
import { RpcEventSource } from "./engine/sources/rpcEventSource";
import { Watchdog, WATCHDOG_INTERVAL_MS } from "./engine/watchdog";
import { WatchedWallets } from "./engine/watchedWallets";
import { logger } from "./lib/logger";
import { pruneCounters } from "./modules/auth/throttle";

// worker process: ingestion, reconciliation, watchdog, expiry sweeper.

const POLL_MS = 2000;
const controller = new AbortController();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (controller.signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", done);
      resolve();
    }
    controller.signal.addEventListener("abort", done, { once: true });
  });
}

/** Runs `fn` forever. Failures back off 1 s -> 30 s; the loop itself never dies. */
async function loop(name: string, fn: () => Promise<number>, backoff: boolean): Promise<void> {
  let failures = 0;
  while (!controller.signal.aborted) {
    let delay: number;
    try {
      delay = await fn();
      failures = 0;
    } catch (err) {
      failures++;
      delay = backoff ? Math.min(1000 * 2 ** (failures - 1), 30_000) : 5000;
      const level = isDbUnavailable(err) || failures > 1 ? "warn" : "error";
      logger[level]({ err, loop: name, failures, retryInMs: delay }, "worker loop failed");
    }
    await sleep(delay);
  }
}

async function main(): Promise<void> {
  const alerter = createAlerter(logger, env.ALERT_TELEGRAM_BOT_TOKEN, env.ALERT_TELEGRAM_CHAT_ID);
  const watched = new WatchedWallets(prisma);
  const source = new RpcEventSource({
    rpcUrl: env.STELLAR_RPC_URL,
    networkPassphrase: env.NETWORK_PASSPHRASE,
    logger,
  });
  const backfill = new HorizonBackfillSource({ horizonUrl: env.HORIZON_URL, logger });
  const ingestion = new Ingestion({
    prisma,
    source,
    backfill,
    watched,
    alerter,
    logger,
    networkPassphrase: env.NETWORK_PASSPHRASE,
  });
  const watchdog = new Watchdog({
    ingestion,
    source,
    alerter,
    logger,
    onStale: () => {
      logger.fatal("ingestion heartbeat stale; exiting for restart");
      process.exit(1);
    },
  });
  const listener = new PgListener({
    connectionString: env.DATABASE_URL,
    channels: [CHANNELS.walletsChanged],
    onNotification: () => watched.markDirty(),
    onConnect: () => watched.markDirty(),
    logger,
  });
  await listener.start();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "worker shutting down after the current batch");
    controller.abort();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  logger.info({ rpc: env.STELLAR_RPC_URL }, "worker started");
  await Promise.all([
    // 2 s between polls, none when the page was full.
    loop("ingestion", async () => ((await ingestion.tick()).full ? 0 : POLL_MS), true),
    loop("sweeper", async () => (await sweepExpired(prisma), SWEEP_INTERVAL_MS), false),
    loop("housekeeping", async () => (await pruneCounters(prisma), 10 * 60_000), false),
    loop("reconciliation", async () => (await sleep(RECONCILE_INTERVAL_MS), controller.signal.aborted || (await reconcile(ingestion)), 0), false),
    loop("watchdog", async () => (await watchdog.check(), WATCHDOG_INTERVAL_MS), false),
  ]);

  await listener.stop();
  await prisma.$disconnect();
  logger.info("worker stopped");
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "worker crashed");
  process.exit(1);
});
