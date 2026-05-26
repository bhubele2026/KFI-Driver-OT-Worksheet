import { and, eq, sql, desc } from "drizzle-orm";
import { db, schema } from "../db.js";
import { logger } from "../logger.js";
import { getClaudeClient, DEFAULT_CLAUDE_MODEL } from "../parsers/claude.js";

/**
 * Task #406 (T004): per-customer lessons feedback for the AI extractor.
 *
 * Each time the dispatcher applies a Claude-chat-proposed fix and ticks
 * "save lesson", a row lands in `customer_extraction_lessons`. On every
 * future AI extraction for the same customer we look up the active
 * lessons, format them as a prepended system-prompt section, and pass
 * them through `AiExtractOptions.lessons` so the model stops repeating
 * the same mistake.
 *
 * The list is capped so the prompt prefix doesn't grow without bound.
 * When the total exceeds `MAX_LESSON_CHARS` we ask Claude to condense
 * the oldest lessons into a single summary line and replace those
 * source rows with a single archived-and-condensed entry; admins can
 * still review the originals in `/admin/customers/:id/lessons`.
 */
export const MAX_LESSON_CHARS = 6_000; // ~1.5k tokens; comfortably under our prompt budget.
const CONDENSE_TIMEOUT_MS = 30_000;

/**
 * Load the active lessons for a customer, newest-first, capped at the
 * char budget. We do NOT run the condense pass automatically here —
 * that's an admin/maintenance action invoked by `condenseLessons`
 * below so request-path latency stays predictable. When the active
 * set exceeds the budget we simply truncate the oldest off the prompt.
 */
export async function loadLessonsForPrompt(
  customer: string,
): Promise<string[]> {
  const rows = await db
    .select({
      lessonText: schema.customerExtractionLessonsTable.lessonText,
      createdAt: schema.customerExtractionLessonsTable.createdAt,
    })
    .from(schema.customerExtractionLessonsTable)
    .where(
      and(
        sql`lower(${schema.customerExtractionLessonsTable.customer}) = lower(${customer})`,
        eq(schema.customerExtractionLessonsTable.active, true),
      ),
    )
    .orderBy(desc(schema.customerExtractionLessonsTable.createdAt));
  if (rows.length === 0) return [];
  // Newest-first; emit oldest at the top so reading order is
  // chronological. Drop oldest if we exceed the char cap.
  const reversed = [...rows].reverse();
  let total = 0;
  const kept: string[] = [];
  for (const r of reversed) {
    const t = r.lessonText.trim();
    if (!t) continue;
    if (total + t.length + 2 > MAX_LESSON_CHARS) continue;
    kept.push(t);
    total += t.length + 2;
  }
  return kept;
}

/**
 * Admin-triggered condense pass. Combines the oldest N active lessons
 * into a single Claude-summarised line, archives the originals
 * (`active=false`), and inserts the summary as a new active row.
 * Idempotent: when total active size is under the budget this is a no-op
 * and returns `{ condensed: 0 }`.
 */
export async function condenseLessons(
  customer: string,
  actorUserId: number | null,
): Promise<{ condensed: number; summaryId: number | null }> {
  const rows = await db
    .select()
    .from(schema.customerExtractionLessonsTable)
    .where(
      and(
        sql`lower(${schema.customerExtractionLessonsTable.customer}) = lower(${customer})`,
        eq(schema.customerExtractionLessonsTable.active, true),
      ),
    )
    .orderBy(desc(schema.customerExtractionLessonsTable.createdAt));
  const totalChars = rows.reduce((s, r) => s + r.lessonText.length + 2, 0);
  if (totalChars <= MAX_LESSON_CHARS) {
    return { condensed: 0, summaryId: null };
  }
  // Condense everything older than the newest 5.
  const keep = rows.slice(0, 5);
  const toCondense = rows.slice(5);
  if (toCondense.length === 0) return { condensed: 0, summaryId: null };

  const prompt = [
    `You are condensing a payroll-data-extractor's "lessons learned" notes for customer "${customer}".`,
    `Below are ${toCondense.length} older lessons the dispatcher saved from past corrections.`,
    `Produce a single short paragraph (<= 600 characters, no bullets) that preserves every actionable rule.`,
    `Output ONLY the paragraph — no preamble, no quotes.`,
    ``,
    ...toCondense.map((r, i) => `${i + 1}. ${r.lessonText.trim()}`),
  ].join("\n");

  let summary: string;
  try {
    const client = getClaudeClient();
    const model = process.env.CLAUDE_EXTRACT_MODEL ?? DEFAULT_CLAUDE_MODEL;
    const resp = await client.messages.create(
      {
        model,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      },
      { timeout: CONDENSE_TIMEOUT_MS },
    );
    const text = resp.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    if (!text) throw new Error("empty condense response");
    summary = text.slice(0, 1000);
  } catch (err) {
    logger.warn(
      { err, customer, count: toCondense.length },
      "lessons condense failed; keeping originals",
    );
    return { condensed: 0, summaryId: null };
  }

  const newId = await db.transaction(async (tx) => {
    await tx
      .update(schema.customerExtractionLessonsTable)
      .set({ active: false, updatedBy: actorUserId })
      .where(
        sql`${schema.customerExtractionLessonsTable.id} IN (${sql.join(
          toCondense.map((r) => sql`${r.id}`),
          sql`, `,
        )})`,
      );
    const [inserted] = await tx
      .insert(schema.customerExtractionLessonsTable)
      .values({
        customer,
        lessonText: `[condensed summary of ${toCondense.length} older lessons] ${summary}`,
        createdBy: actorUserId,
        active: true,
      })
      .returning({ id: schema.customerExtractionLessonsTable.id });
    return inserted.id;
  });
  logger.info(
    { customer, condensed: toCondense.length, kept: keep.length, newId },
    "lessons_condensed",
  );
  return { condensed: toCondense.length, summaryId: newId };
}

/**
 * Format the lessons list as the block prepended to the AI extractor's
 * system prompt. Kept simple by design: a labelled section the model
 * will quote back when we ask "why did you change behaviour" during
 * the next chat. Returns empty string when there are no lessons.
 */
export function formatLessonsBlock(lessons: string[]): string {
  if (lessons.length === 0) return "";
  const lines = [
    `## Lessons learned from past dispatcher corrections`,
    `Apply these rules before the general instructions below. Each line is a correction the dispatcher made on a previous upload from this customer; do not repeat the same mistake.`,
  ];
  for (const l of lessons) lines.push(`- ${l}`);
  lines.push("");
  return lines.join("\n");
}
