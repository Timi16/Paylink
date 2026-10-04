import type { Logger } from "pino";

export interface Alerter {
  /** Never throws: a failed alert must not take the worker down with it. */
  alert(message: string): Promise<void>;
}

export class LogAlerter implements Alerter {
  constructor(private readonly logger: Logger) {}
  async alert(message: string): Promise<void> {
    this.logger.warn({ alert: true }, message);
  }
}

export class TelegramAlerter implements Alerter {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly logger: Logger,
  ) {}

  async alert(message: string): Promise<void> {
    this.logger.warn({ alert: true }, message);
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text: `[PayLink] ${message}` }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.logger.error({ status: res.status }, "telegram alert rejected");
    } catch {
      // The URL contains the bot token, so the error object is deliberately not logged.
      this.logger.error("telegram alert failed to send");
    }
  }
}

export function createAlerter(
  logger: Logger,
  botToken: string | undefined,
  chatId: string | undefined,
): Alerter {
  return botToken && chatId ? new TelegramAlerter(botToken, chatId, logger) : new LogAlerter(logger);
}
