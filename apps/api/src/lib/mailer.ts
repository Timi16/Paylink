import nodemailer from "nodemailer";
import type { Logger } from "pino";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Sends through the SMTP server in SMTP_URL (e.g. smtps://user:pass@smtp.example.com:465). */
export class SmtpMailer implements Mailer {
  private readonly transport: nodemailer.Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text });
  }
}

/**
 * Local development only: prints the email to the log instead of sending it, so a reset
 * link can be followed without a mail server. Never used in production.
 */
export class DevLogMailer implements Mailer {
  constructor(private readonly logger: Logger) {}

  async send(mail: Mail): Promise<void> {
    this.logger.info({ to: mail.to, subject: mail.subject }, `[dev mail]\n${mail.text}`);
  }
}

/** null in production without SMTP_URL: features that need email answer "not set up". */
export function createMailer(
  opts: { smtpUrl?: string; from: string; production: boolean },
  logger: Logger,
): Mailer | null {
  if (opts.smtpUrl) return new SmtpMailer(opts.smtpUrl, opts.from);
  return opts.production ? null : new DevLogMailer(logger);
}
