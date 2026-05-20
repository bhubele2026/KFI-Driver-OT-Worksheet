import { logger } from "./logger.js";

// Email delivery is intentionally disabled. SendGrid was removed so the
// production API server can boot without an integration connected. The
// exported surface is kept stable (initMailer / refreshMailerConfigured /
// isMailerConfigured / sendMail) so existing callers compile unchanged —
// every send is a logged no-op that returns { delivered: false }. Reconnect
// a mailer later if email is wanted; see replit.md.

let warnedOnce = false;

function warnDisabledOnce(): void {
  if (warnedOnce) return;
  warnedOnce = true;
  logger.warn("email disabled — mailer is not configured (SendGrid removed)");
}

export async function initMailer(): Promise<void> {
  // No-op. Kept for callers that prime the mailer at boot.
}

export async function refreshMailerConfigured(): Promise<boolean> {
  return false;
}

export function isMailerConfigured(): boolean {
  return false;
}

export async function sendMail(args: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<{ delivered: false; reason: "disabled" }> {
  warnDisabledOnce();
  logger.warn(
    { to: args.to, subject: args.subject },
    "email disabled; skipping send",
  );
  return { delivered: false, reason: "disabled" };
}
