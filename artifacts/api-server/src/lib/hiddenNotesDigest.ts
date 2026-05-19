import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, schema } from "./db.js";
import { logger } from "./logger.js";
import { isMailerConfigured, sendMail } from "./mailer.js";
import { appBaseUrl } from "./appBaseUrl.js";

const HOUR_MS = 60 * 60 * 1000;
const DIGEST_WINDOW_MS = 24 * HOUR_MS;
const TICK_INTERVAL_MS = HOUR_MS;

// Hour-of-day (UTC) at which to send the digest. Tunable via env so ops can
// shift it to land in business hours for the audience. Defaults to 13:00 UTC
// (~8 AM Central) which lines up with the start of the dispatch day.
function digestHourUtc(): number {
  const raw = process.env.HIDDEN_NOTES_DIGEST_HOUR_UTC;
  if (!raw) return 13;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 23) return 13;
  return n;
}

function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type HiddenNoteRow = {
  id: number;
  weekStart: string;
  kfiId: string;
  driverName: string | null;
  body: string;
  deletedAt: Date;
  deletedByEmail: string | null;
};

export async function listRecentlyHiddenNotes(
  since: Date,
): Promise<HiddenNoteRow[]> {
  const deleter = alias(schema.usersTable, "deleter");
  const rows = await db
    .select({
      id: schema.driverNotesTable.id,
      weekStart: schema.driverNotesTable.weekStart,
      kfiId: schema.driverNotesTable.kfiId,
      driverName: schema.driversTable.name,
      body: schema.driverNotesTable.body,
      deletedAt: schema.driverNotesTable.deletedAt,
      deletedByEmail: deleter.email,
    })
    .from(schema.driverNotesTable)
    .leftJoin(
      schema.driversTable,
      eq(schema.driversTable.kfiId, schema.driverNotesTable.kfiId),
    )
    .leftJoin(
      deleter,
      eq(deleter.id, schema.driverNotesTable.deletedByUserId),
    )
    .where(
      and(
        isNotNull(schema.driverNotesTable.deletedAt),
        gte(schema.driverNotesTable.deletedAt, since),
      ),
    )
    .orderBy(desc(schema.driverNotesTable.deletedAt));
  return rows.map((r) => ({
    id: r.id,
    weekStart: r.weekStart,
    kfiId: r.kfiId,
    driverName: r.driverName ?? null,
    body: r.body,
    // deletedAt is non-null thanks to the WHERE filter above.
    deletedAt: r.deletedAt as Date,
    deletedByEmail: r.deletedByEmail ?? null,
  }));
}

function buildDigestEmail(
  notes: HiddenNoteRow[],
  link: string,
): { subject: string; text: string; html: string } {
  const subject = `KFI Dispatch: ${notes.length} hidden note${notes.length === 1 ? "" : "s"} in the last 24 hours`;
  const lines: string[] = [
    `${notes.length} note${notes.length === 1 ? "" : "s"} hidden in the last 24 hours:`,
    "",
  ];
  for (const n of notes) {
    const driver = n.driverName ? `${n.driverName} (${n.kfiId})` : n.kfiId;
    const actor = n.deletedByEmail ?? "unknown";
    const when = n.deletedAt.toISOString();
    const preview = n.body.length > 200 ? `${n.body.slice(0, 200)}…` : n.body;
    lines.push(`- ${driver}  week ${n.weekStart}`);
    lines.push(`  hidden by ${actor} at ${when}`);
    lines.push(`  note: ${preview}`);
    lines.push("");
  }
  lines.push(`Review them here: ${link}`);
  const text = lines.join("\n");
  const rows = notes
    .map((n) => {
      const driver = n.driverName
        ? `${esc(n.driverName)} <span style="color:#64748b">(${esc(n.kfiId)})</span>`
        : esc(n.kfiId);
      const actor = esc(n.deletedByEmail ?? "unknown");
      const when = esc(n.deletedAt.toISOString());
      const preview = esc(
        n.body.length > 200 ? `${n.body.slice(0, 200)}…` : n.body,
      );
      return `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top">${driver}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top;white-space:nowrap">${esc(n.weekStart)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top">${actor}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top;color:#64748b;font-size:12px;white-space:nowrap">${when}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top">${preview}</td>
        </tr>`;
    })
    .join("");
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a">
      <p>${esc(`${notes.length} note${notes.length === 1 ? "" : "s"} hidden in the last 24 hours.`)}</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        <thead>
          <tr style="background:#f1f5f9;text-align:left">
            <th style="padding:8px 12px;border-bottom:1px solid #cbd5e1">Driver</th>
            <th style="padding:8px 12px;border-bottom:1px solid #cbd5e1">Week</th>
            <th style="padding:8px 12px;border-bottom:1px solid #cbd5e1">Hidden by</th>
            <th style="padding:8px 12px;border-bottom:1px solid #cbd5e1">When (UTC)</th>
            <th style="padding:8px 12px;border-bottom:1px solid #cbd5e1">Note</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:16px">
        <a href="${esc(link)}" style="color:#0f766e">Review hidden notes &rarr;</a>
      </p>
    </div>`;
  return { subject, text, html };
}

export type DigestResult = {
  hiddenCount: number;
  adminCount: number;
  delivered: number;
  skippedReason?: "mailer-not-configured" | "no-hidden-notes" | "no-admins";
};

export async function runHiddenNotesDigest(
  now: Date = new Date(),
): Promise<DigestResult> {
  if (!isMailerConfigured()) {
    return {
      hiddenCount: 0,
      adminCount: 0,
      delivered: 0,
      skippedReason: "mailer-not-configured",
    };
  }
  const since = new Date(now.getTime() - DIGEST_WINDOW_MS);
  const notes = await listRecentlyHiddenNotes(since);
  if (notes.length === 0) {
    return {
      hiddenCount: 0,
      adminCount: 0,
      delivered: 0,
      skippedReason: "no-hidden-notes",
    };
  }
  const admins = await db
    .select({ email: schema.usersTable.email })
    .from(schema.usersTable)
    .where(
      and(
        eq(schema.usersTable.isAdmin, true),
        eq(schema.usersTable.isActive, true),
        eq(schema.usersTable.hiddenNotesDigestOptIn, true),
      ),
    );
  if (admins.length === 0) {
    return {
      hiddenCount: notes.length,
      adminCount: 0,
      delivered: 0,
      skippedReason: "no-admins",
    };
  }
  const base = appBaseUrl();
  const link = `${base ?? ""}/admin/notes`;
  const { subject, text, html } = buildDigestEmail(notes, link);
  let delivered = 0;
  for (const admin of admins) {
    try {
      const result = await sendMail({ to: admin.email, subject, text, html });
      if (result.delivered) delivered++;
    } catch (err) {
      logger.warn(
        { err, to: admin.email },
        "hidden notes digest: send failed for admin",
      );
    }
  }
  logger.info(
    { hiddenCount: notes.length, adminCount: admins.length, delivered },
    "hidden notes digest sent",
  );
  return { hiddenCount: notes.length, adminCount: admins.length, delivered };
}

// In-memory marker prevents duplicate sends within the same UTC day. The API
// runs single-process (see replit.md realtime section), so this is correct;
// the worst case after a restart that crosses the digest hour is a missed or
// duplicate send, which is acceptable for a best-effort notification (the
// in-app hidden-notes badge is the canonical signal).
let lastSentYmdUtc: string | null = null;

function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function _resetDigestSchedulerStateForTests(): void {
  lastSentYmdUtc = null;
}

export function startHiddenNotesDigest(): NodeJS.Timeout {
  const hour = digestHourUtc();
  const tick = () => {
    const now = new Date();
    if (now.getUTCHours() !== hour) return;
    const ymd = ymdUtc(now);
    if (lastSentYmdUtc === ymd) return;
    lastSentYmdUtc = ymd;
    runHiddenNotesDigest(now).catch((err) => {
      logger.warn({ err }, "hidden notes digest tick failed");
    });
  };
  void tick();
  const handle = setInterval(tick, TICK_INTERVAL_MS);
  if (typeof handle.unref === "function") handle.unref();
  return handle;
}
