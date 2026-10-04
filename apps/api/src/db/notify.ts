import { Client } from "pg";
import type { Logger } from "pino";
import type { Db } from "./prisma";

export const CHANNELS = {
  requestUpdated: "request_updated",
  paymentDetected: "payment_detected",
  walletsChanged: "wallets_changed",
} as const;
export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

export interface RequestUpdatedPayload {
  id: string;
  publicId: string;
  merchantId: string;
}
export interface PaymentDetectedPayload {
  eventId: string;
  merchantId: string;
}
export interface WalletsChangedPayload {
  walletId: string;
  merchantId: string;
}

/**
 * NOTIFY is transactional in Postgres: called inside a transaction, the message is
 * delivered only if (and when) that transaction commits.
 */
export async function notify(db: Db, channel: Channel, payload: object): Promise<void> {
  await db.$executeRaw`SELECT pg_notify(${channel}, ${JSON.stringify(payload)})`;
}

export interface PgListenerOptions {
  connectionString: string;
  channels: Channel[];
  onNotification: (channel: Channel, payload: unknown) => void;
  /** Called after every (re)connect; notifications may have been missed while down. */
  onConnect?: () => void;
  logger: Logger;
}

/** One dedicated pg connection that LISTENs and reconnects forever with backoff. */
export class PgListener {
  private client: Client | null = null;
  private stopped = false;
  private retryMs = 1000;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: PgListenerOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect().catch((err: unknown) => {
      this.opts.logger.warn({ err }, "pg listener: initial connect failed, retrying");
      this.scheduleReconnect();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    const client = new Client({ connectionString: this.opts.connectionString, keepAlive: true });
    client.on("notification", (msg) => {
      let payload: unknown;
      try {
        payload = msg.payload ? JSON.parse(msg.payload) : null;
      } catch {
        return;
      }
      try {
        this.opts.onNotification(msg.channel as Channel, payload);
      } catch (err) {
        this.opts.logger.error({ err, channel: msg.channel }, "pg listener: handler failed");
      }
    });
    const onLost = (err?: unknown) => {
      if (this.client !== client) return;
      this.client = null;
      if (this.stopped) return;
      this.opts.logger.warn({ err }, "pg listener: connection lost, reconnecting");
      client.end().catch(() => undefined);
      this.scheduleReconnect();
    };
    client.on("error", onLost);
    client.on("end", () => onLost());
    try {
      await client.connect();
      for (const channel of this.opts.channels) await client.query(`LISTEN ${channel}`);
    } catch (err) {
      client.removeAllListeners();
      client.on("error", () => undefined);
      await client.end().catch(() => undefined);
      throw err;
    }
    if (this.stopped) {
      await client.end().catch(() => undefined);
      return;
    }
    this.client = client;
    this.retryMs = 1000;
    this.opts.onConnect?.();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect().catch((err: unknown) => {
        this.opts.logger.warn({ err }, "pg listener: reconnect failed");
        this.scheduleReconnect();
      });
    }, delay);
    this.timer.unref();
  }
}
