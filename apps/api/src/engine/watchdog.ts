import type { Logger } from "pino";
import type { Alerter } from "./alerter";
import type { Ingestion } from "./ingestion";
import type { StellarSource } from "./sources/StellarSource";

export const WATCHDOG_INTERVAL_MS = 30_000;
const MAX_LAG_LEDGERS = 12; // about 60 s
const LAG_GRACE_MS = 120_000;
const HEARTBEAT_STALE_MS = 180_000;

export interface WatchdogDeps {
  ingestion: Ingestion;
  source: StellarSource;
  alerter: Alerter;
  logger: Logger;
  /** Called when the ingestion loop is stuck; production exits so pm2 restarts us. */
  onStale: () => void;
  now?: () => number;
}

/** Alerts when ingestion falls behind for 2 minutes, and bails out if the loop hangs. */
export class Watchdog {
  private laggingSince: number | null = null;
  private alerted = false;

  constructor(private readonly deps: WatchdogDeps) {}

  async check(): Promise<{ lagLedgers: number | null; stale: boolean }> {
    const now = (this.deps.now ?? Date.now)();
    if (now - this.deps.ingestion.lastTickAt > HEARTBEAT_STALE_MS) {
      await this.deps.alerter.alert("Worker heartbeat is stale; restarting the worker.");
      this.deps.onStale();
      return { lagLedgers: null, stale: true };
    }

    let lag: number | null;
    try {
      const [tip, cursor] = await Promise.all([
        this.deps.source.getTip(),
        this.deps.ingestion.loadCursor(),
      ]);
      lag = cursor ? Math.max(tip.ledger - cursor.ledger, 0) : null;
    } catch (err) {
      // RPC or DB unreachable: we cannot be keeping up, so treat it as lag.
      this.deps.logger.warn({ err }, "watchdog: could not measure lag");
      lag = Number.MAX_SAFE_INTEGER;
    }

    if (lag !== null && lag > MAX_LAG_LEDGERS) {
      this.laggingSince ??= now;
      if (!this.alerted && now - this.laggingSince >= LAG_GRACE_MS) {
        this.alerted = true;
        const shown = lag === Number.MAX_SAFE_INTEGER ? "unknown (RPC or DB unreachable)" : `${lag} ledgers`;
        await this.deps.alerter.alert(`Ingestion is lagging: ${shown} behind for over 2 minutes.`);
      }
    } else {
      if (this.alerted) await this.deps.alerter.alert("Ingestion has caught up.");
      this.laggingSince = null;
      this.alerted = false;
    }
    return { lagLedgers: lag, stale: false };
  }
}
