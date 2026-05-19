import sgMail from "@sendgrid/mail";
import { logger } from "./logger.js";

// Mailer is wired to the Replit SendGrid integration. The connector proxy
// hands us a short-lived API key; we re-fetch it on every send so token
// rotation Just Works. `isMailerConfigured()` stays synchronous (a lot of
// callers branch on it) and reflects the *last known* lookup result —
// `initMailer()` primes it at boot and every successful/failed `sendMail`
// keeps it in sync.

let cachedConfigured = false;

type SendGridConnectionSettings = {
  api_key?: unknown;
  apiKey?: unknown;
  SENDGRID_API_KEY?: unknown;
};

async function fetchSendGridApiKey(): Promise<string | null> {
  // Direct env override — keeps tests / non-Replit deployments working and
  // is also handy as an escape hatch if the connector ever has an outage.
  const envKey = process.env.SENDGRID_API_KEY;
  if (envKey) return envKey;

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  if (!hostname) return null;
  const xReplitToken = process.env.REPL_IDENTITY
    ? `repl ${process.env.REPL_IDENTITY}`
    : process.env.WEB_REPL_RENEWAL
      ? `depl ${process.env.WEB_REPL_RENEWAL}`
      : null;
  if (!xReplitToken) return null;

  try {
    const res = await fetch(
      `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=sendgrid`,
      {
        headers: {
          Accept: "application/json",
          X_REPLIT_TOKEN: xReplitToken,
        },
      },
    );
    if (!res.ok) {
      logger.warn(
        { status: res.status },
        "sendgrid connector proxy returned non-2xx",
      );
      return null;
    }
    const data = (await res.json()) as {
      items?: Array<{ settings?: SendGridConnectionSettings }>;
    };
    const settings = data.items?.[0]?.settings;
    const raw =
      settings?.api_key ?? settings?.apiKey ?? settings?.SENDGRID_API_KEY;
    if (typeof raw === "string" && raw.length > 0) return raw;
    return null;
  } catch (err) {
    logger.warn({ err }, "sendgrid connector lookup failed");
    return null;
  }
}

export async function initMailer(): Promise<void> {
  await refreshMailerConfigured();
}

// Re-fetches the SendGrid connector lookup and updates the cached flag.
// Call this before any code path that gates on `isMailerConfigured()` for a
// user-visible decision (status endpoint, admin 503 prechecks, the daily
// digest). Otherwise an admin who connects SendGrid after boot would keep
// seeing "not configured" until the next server restart.
export async function refreshMailerConfigured(): Promise<boolean> {
  const key = await fetchSendGridApiKey();
  cachedConfigured = !!key;
  return cachedConfigured;
}

export function isMailerConfigured(): boolean {
  return cachedConfigured;
}

const FROM_DEFAULT = "no-reply@kfi-ot.local";

export async function sendMail(args: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<{ delivered: boolean }> {
  const apiKey = await fetchSendGridApiKey();
  if (!apiKey) {
    cachedConfigured = false;
    logger.warn(
      { to: args.to, subject: args.subject },
      "mailer not configured (connect SendGrid via Replit integrations); skipping send",
    );
    return { delivered: false };
  }
  cachedConfigured = true;
  sgMail.setApiKey(apiKey);
  const from = process.env.MAIL_FROM ?? FROM_DEFAULT;
  await sgMail.send({
    from,
    to: args.to,
    subject: args.subject,
    text: args.text,
    ...(args.html ? { html: args.html } : {}),
  });
  logger.info({ to: args.to, subject: args.subject }, "email sent");
  return { delivered: true };
}
