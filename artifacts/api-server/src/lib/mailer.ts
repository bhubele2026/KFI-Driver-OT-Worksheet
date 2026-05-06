import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "./logger.js";

let cachedTransport: Transporter | null | undefined = undefined;

function buildTransport(): Transporter | null {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !port) return null;
  return nodemailer.createTransport({
    host,
    port: Number(port),
    secure: Number(port) === 465,
    auth: user && pass ? { user, pass } : undefined,
  });
}

function getTransport(): Transporter | null {
  if (cachedTransport === undefined) cachedTransport = buildTransport();
  return cachedTransport;
}

export function isMailerConfigured(): boolean {
  return getTransport() !== null;
}

const FROM = process.env.MAIL_FROM ?? "no-reply@kfi-ot.local";

export async function sendMail(args: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<{ delivered: boolean }> {
  const t = getTransport();
  if (!t) {
    logger.warn(
      { to: args.to, subject: args.subject },
      "mailer not configured (set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM); skipping send",
    );
    return { delivered: false };
  }
  await t.sendMail({
    from: FROM,
    to: args.to,
    subject: args.subject,
    text: args.text,
    html: args.html,
  });
  logger.info({ to: args.to, subject: args.subject }, "email sent");
  return { delivered: true };
}
