import { buildApp } from "./app";
import { env, isProduction } from "./config/env";
import { CHANNELS, PgListener } from "./db/notify";
import { prisma } from "./db/prisma";
import { logger } from "./lib/logger";
import { createMailer } from "./lib/mailer";
import { LiveHub } from "./modules/stream/hub";
import { HorizonAccountLoader } from "./modules/wallets/horizonAccounts";

// api process

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  const hub = new LiveHub(prisma, logger);
  // One pg connection LISTENs and fans out to in-memory SSE subscribers.
  const listener = new PgListener({
    connectionString: env.DATABASE_URL,
    channels: [CHANNELS.requestUpdated, CHANNELS.paymentDetected, CHANNELS.walletsChanged],
    onNotification: hub.handleNotification,
    onConnect: hub.resync,
    logger,
  });
  await listener.start();

  const { app, sse } = buildApp({
    prisma,
    accounts: new HorizonAccountLoader(env.HORIZON_URL),
    hub,
    logger,
    mailer: createMailer({ smtpUrl: env.SMTP_URL, from: env.MAIL_FROM, production: isProduction }, logger),
  });

  const server = app.listen(env.PORT, env.HOST, () => {
    logger.info({ host: env.HOST, port: env.PORT, env: env.NODE_ENV }, "api listening");
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "api shutting down");
    // Stop accepting, close SSE streams, wait up to 10 s, then disconnect Prisma.
    const force = setTimeout(() => {
      logger.warn("shutdown grace period over; closing remaining connections");
      server.closeAllConnections();
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      Promise.allSettled([listener.stop(), prisma.$disconnect()])
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
    sse.closeAll();
    server.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "api failed to start");
  process.exit(1);
});
