import nodemailer, { type Mail } from "nodemailer";
import { config } from "../config.js";

/**
 * Sends operational email (alerts and digests). One SMTP adapter covers self-hosting (any SMTP
 * provider) and the hosted service (Amazon SES over SMTP). Tests swap in a fake with setMailer.
 */
export interface OutgoingEmail { to: string; subject: string; text: string }

export interface Mailer {
  readonly name: string;
  readonly enabled: boolean;
  send(email: OutgoingEmail): Promise<void>;
}

export class SmtpMailer implements Mailer {
  readonly name = "smtp";
  readonly enabled = true;
  private readonly transport: Mail;
  constructor(url: string, private readonly from: string) {
    const u = new URL(url);
    if (u.protocol !== "smtp:" && u.protocol !== "smtps:") throw new Error("SMTP_URL must start with smtp:// or smtps://");
    const secure = u.protocol === "smtps:";
    this.transport = nodemailer.createTransport({
      host: u.hostname, port: u.port ? Number(u.port) : secure ? 465 : 587, secure,
      requireTLS: !secure && u.hostname !== "localhost" && u.hostname !== "127.0.0.1", // STARTTLS required off-box
      auth: u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : undefined,
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    });
  }
  async send(email: OutgoingEmail): Promise<void> {
    // Subjects never carry line breaks (header injection); nodemailer encodes the rest.
    await this.transport.sendMail({ from: this.from, to: email.to, subject: email.subject.replace(/[\r\n]+/g, " ").slice(0, 200), text: email.text });
  }
}

export class DisabledMailer implements Mailer {
  readonly name = "disabled";
  readonly enabled = false;
  async send(): Promise<void> {
    throw new Error("email is not configured (set SMTP_URL)");
  }
}

let mailer: Mailer | undefined;
export function getMailer(): Mailer {
  if (!mailer) {
    const cfg = config();
    mailer = cfg.SMTP_URL ? new SmtpMailer(cfg.SMTP_URL, cfg.SMTP_FROM) : new DisabledMailer();
  }
  return mailer;
}
export const setMailer = (m: Mailer): void => {
  mailer = m;
};
