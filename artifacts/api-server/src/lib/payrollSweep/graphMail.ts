import { logger } from "../logger.js";

/**
 * Read-only Microsoft Graph access to the payroll mailbox.
 *
 * ⚠️⚠️ THE MAILBOX IS A HARDCODED CONSTANT AND MUST STAY ONE.
 *
 * The app registration this runs as (`Outlook-Email-Sandbox`) holds
 * admin-consented APPLICATION permissions that are tenant-wide: Mail.Read,
 * Mail.ReadBasic.All, Mail.ReadWrite and Mail.Send. That is far more than this
 * feature needs — it could read any KFI mailbox and send as anyone. Brad chose
 * to reuse it rather than mint a scoped app, so the narrowing happens HERE:
 *
 *  1. every request path is built from PAYROLL_MAILBOX, never from config,
 *     never from a request parameter, never from anything a model produced;
 *  2. this module exports READS ONLY. There is deliberately no send, move,
 *     copy or delete wrapper, so none can be called by accident. A test pins
 *     that by reading this file's own source.
 *
 * If you are adding a "just this once" write here: don't. Add it to a separate
 * module with its own credential, or get the ApplicationAccessPolicy in place
 * first (it would scope this appId to payroll@ tenant-side — recommended, but
 * it binds every other consumer of that app, so IT has to agree).
 *
 * Brad's standing rule, 2026-09-16: "AP email" means payroll@. Never AP@.
 */
export const PAYROLL_MAILBOX = "payroll@kfistaffing.com";

const GRAPH = "https://graph.microsoft.com/v1.0";
const LOGIN = "https://login.microsoftonline.com";

/** Default is the app registration Brad chose; overridable for a scoped one. */
const DEFAULT_CLIENT_ID = "e46d089f-f50d-4eca-b7d5-5ee04da55164";

export type MailHeader = {
  /** Graph id — per-folder and UNSTABLE; never use it as an identity. */
  id: string;
  /** Stable across folder moves. This is the identity. */
  internetMessageId: string;
  conversationId: string | null;
  subject: string;
  from: string;
  fromName: string;
  to: string[];
  cc: string[];
  receivedAt: string;
  sentAt: string | null;
  categories: string[];
  hasAttachments: boolean;
  parentFolderId: string | null;
  bodyPreview: string;
};

export type MailBody = MailHeader & {
  /** Plain text, quoted history INCLUDED — the final numbers live in there. */
  text: string;
  attachmentNames: string[];
};

export function mailConfigured(): boolean {
  return Boolean(
    process.env.PAYROLL_MAIL_TENANT_ID && process.env.PAYROLL_MAIL_CLIENT_SECRET,
  );
}

let cached: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.token;

  const tenant = process.env.PAYROLL_MAIL_TENANT_ID;
  const clientId = process.env.PAYROLL_MAIL_CLIENT_ID ?? DEFAULT_CLIENT_ID;
  const secret = process.env.PAYROLL_MAIL_CLIENT_SECRET;
  if (!tenant || !secret) {
    throw new Error(
      "payroll mail sweep unavailable: set PAYROLL_MAIL_TENANT_ID and PAYROLL_MAIL_CLIENT_SECRET",
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: secret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(`${LOGIN}/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    // ⚠️ Never echo the response body — it can carry the client secret back.
    throw new Error(`graph token request failed: ${res.status}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("graph token response had no access_token");
  // Refresh a minute early so a long run never holds a token that expires mid-flight.
  cached = {
    token: json.access_token,
    expiresAt: now + Math.max(60, (json.expires_in ?? 3600) - 60) * 1000,
  };
  return cached.token;
}

/** Reset between tests; also lets a 401 force a fresh token once. */
export function _resetTokenCacheForTests(): void {
  cached = null;
}

type GraphMessage = {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  ccRecipients?: Array<{ emailAddress?: { address?: string } }>;
  receivedDateTime?: string;
  sentDateTime?: string;
  categories?: string[];
  hasAttachments?: boolean;
  parentFolderId?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
};

async function graphGet<T>(path: string): Promise<T> {
  const token = await getToken();
  const url = path.startsWith("http") ? path : `${GRAPH}${path}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
    // ⚠️ Graph throttles hard and says exactly how long to wait. Honour it;
    // hammering a 429 gets the app-wide credential throttled for everyone.
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "0");
      const waitMs = Math.min(70_000, (retryAfter > 0 ? retryAfter : 2 ** attempt) * 1000);
      logger.warn({ status: res.status, waitMs, attempt }, "graph backoff");
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) throw new Error(`graph ${res.status} on ${path.split("?")[0]}`);
    return (await res.json()) as T;
  }
  throw new Error(`graph gave up after retries on ${path.split("?")[0]}`);
}

const addr = (a?: { emailAddress?: { address?: string } }): string =>
  (a?.emailAddress?.address ?? "").toLowerCase();

function toHeader(m: GraphMessage): MailHeader {
  return {
    id: m.id,
    // Graph very occasionally omits it; fall back to the Graph id so the row
    // still has an identity rather than collapsing every such message into one.
    internetMessageId: m.internetMessageId ?? `graph:${m.id}`,
    conversationId: m.conversationId ?? null,
    subject: m.subject ?? "",
    from: (m.from?.emailAddress?.address ?? "").toLowerCase(),
    fromName: m.from?.emailAddress?.name ?? "",
    to: (m.toRecipients ?? []).map(addr).filter(Boolean),
    cc: (m.ccRecipients ?? []).map(addr).filter(Boolean),
    receivedAt: m.receivedDateTime ?? "",
    sentAt: m.sentDateTime ?? null,
    categories: m.categories ?? [],
    hasAttachments: Boolean(m.hasAttachments),
    parentFolderId: m.parentFolderId ?? null,
    bodyPreview: m.bodyPreview ?? "",
  };
}

const SELECT = [
  "id", "internetMessageId", "conversationId", "subject", "from", "toRecipients",
  "ccRecipients", "receivedDateTime", "sentDateTime", "categories",
  "hasAttachments", "parentFolderId", "bodyPreview",
].join(",");

/**
 * Headers received in [from, to). Mailbox-wide on purpose.
 *
 * ⚠️ NOT scoped to a folder, and that is deliberate. Brad, 2026-08-27: "going
 * forward it wouldn't be in a folder yet." On the 09.18 run only 5 messages sat
 * in the Inbox over two days while the PD folder held 14 — and two of those
 * five were live payroll changes that never reached the Changes folder at all.
 * A folder-scoped sweep misses exactly the mail that has not been filed yet,
 * which is all the mail that still needs doing.
 *
 * ⚠️ Call this in SLICES of a few days. Graph pages, and a wide window plus a
 * page cap silently drops the oldest — a round 100 is the tell.
 */
export async function listMessages(from: Date, to: Date): Promise<MailHeader[]> {
  const filter =
    `receivedDateTime ge ${from.toISOString()} and receivedDateTime lt ${to.toISOString()}`;
  let url =
    `/users/${PAYROLL_MAILBOX}/messages` +
    `?$select=${SELECT}&$top=50&$orderby=receivedDateTime desc` +
    `&$filter=${encodeURIComponent(filter)}`;

  const out: MailHeader[] = [];
  // Bounded so a pathological nextLink loop cannot spin forever.
  for (let page = 0; page < 40 && url; page++) {
    const json = await graphGet<{ value: GraphMessage[]; "@odata.nextLink"?: string }>(url);
    out.push(...(json.value ?? []).map(toHeader));
    url = json["@odata.nextLink"] ?? "";
  }
  return out;
}

/** Full body for one message, by its (unstable) Graph id. */
export async function getMessage(graphId: string): Promise<MailBody> {
  const m = await graphGet<GraphMessage>(
    `/users/${PAYROLL_MAILBOX}/messages/${encodeURIComponent(graphId)}` +
      `?$select=${SELECT},body`,
  );
  const header = toHeader(m);
  const raw = m.body?.content ?? "";
  const text = (m.body?.contentType ?? "").toLowerCase() === "html"
    ? htmlToText(raw)
    : raw;

  let attachmentNames: string[] = [];
  if (m.hasAttachments) {
    try {
      // ⚠️ Names only. Attachment BYTES are not fetched: nothing downstream
      // reads them, and pulling payroll attachments into the app would store
      // documents the app has no business holding.
      const att = await graphGet<{ value: Array<{ name?: string; isInline?: boolean }> }>(
        `/users/${PAYROLL_MAILBOX}/messages/${encodeURIComponent(graphId)}` +
          `/attachments?$select=name,isInline`,
      );
      attachmentNames = (att.value ?? [])
        .filter((a) => !a.isInline)
        .map((a) => a.name ?? "")
        .filter(Boolean);
    } catch (err) {
      // A missing attachment list must not lose the message itself.
      logger.warn({ err, graphId }, "could not list attachment names");
    }
  }
  return { ...header, text, attachmentNames };
}

/**
 * HTML → text, keeping the quoted reply chain.
 *
 * ⚠️ The quoted history is the POINT, not noise. A corrected thread states its
 * final number in the newest message and its original in the quote; rule 1 of
 * the judgment rules ("take the LAST reply's number, and show what it replaced")
 * cannot be applied to a body that has been stripped of what it replaced.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[​-‏‪-‮﻿]/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
