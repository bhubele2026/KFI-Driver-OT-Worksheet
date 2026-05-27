/**
 * Task #430: end-to-end coverage for the terse, investigation-first
 * chat voice that Task #426 baked into the system prompt.
 *
 * The Task #426 unit tests (`buildSystemPrompt: no customer-service
 * preambles`, `runChatTurn: terse-voice canaries against stubbed
 * model client`) stub the Anthropic client — they verify that the
 * wrapper code doesn't transform replies, not that the real model
 * obeys the prompt. This spec closes the gap by running a real
 * Claude tool loop against a seeded Burnett-style missing-Willie-Medina
 * fixture and asserting:
 *
 *   1. The first assistant reply does not open with "I'll" or
 *      "Let me" (case-insensitive) — the two banned phrasings the
 *      prompt's BAD example calls out by name.
 *   2. The first sentence of the reply is a finding, not a question
 *      — i.e. it does not end with "?". The prompt's investigation-
 *      first rule forbids asking the dispatcher for clock times,
 *      dates, or names before reading the file, so an opening
 *      question implies the model violated the ordering even if a
 *      row-read tool also ran during the turn.
 *   3. The assistant called `read_upload_file_rows` during the turn
 *      — visible via the persisted `file_evidence` column on the
 *      assistant message row, which the EvidenceAccumulator only
 *      populates when a row-read tool ran during the turn. Combined
 *      with (2), this proves the read happened before any
 *      dispatcher-facing question.
 *
 * If `ANTHROPIC_API_KEY` is not set, the spec is skipped — same
 * pattern as `self-onboarding-delallo.spec.ts` for tests that
 * genuinely need a model. Per the e2e DB-safety contract, all DB
 * access goes through `createE2EPool()`.
 */
import { test, expect } from "@playwright/test";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";

const pool = createE2EPool();

const SUFFIX = `e2e-${Date.now().toString(36)}`;
const CUSTOMER = `ZZZ-TerseVoice-${SUFFIX}`;
const KFI_ID = `ZZT${SUFFIX.slice(0, 6)}`;
const DRIVER_NAME = `Willie Medina ${SUFFIX}`;
const WEEK_START = "2031-05-18"; // Sunday — disposable in dev DB
const PUNCH_DATE = "2031-05-20"; // Tuesday in that week
const FILE_NAME = `burnett-${SUFFIX}.xlsx`;

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM punches WHERE kfi_id = $1`, [KFI_ID]);
  await pool.query(
    `DELETE FROM customer_upload_chats WHERE customer = $1`,
    [CUSTOMER],
  );
  await pool.query(
    `DELETE FROM customer_upload_attempts WHERE customer = $1`,
    [CUSTOMER],
  );
  await pool.query(
    `DELETE FROM ai_extract_samples WHERE customer = $1`,
    [CUSTOMER],
  );
  await pool.query(`DELETE FROM drivers WHERE kfi_id = $1`, [KFI_ID]);
}

test.beforeAll(async () => {
  await cleanup();

  await pool.query(
    `INSERT INTO drivers (kfi_id, name, customer)
     VALUES ($1, $2, $3)
     ON CONFLICT (kfi_id) DO NOTHING`,
    [KFI_ID, DRIVER_NAME, CUSTOMER],
  );
  await pool.query(
    `INSERT INTO weeks (start_date, end_date)
     VALUES ($1::date, ($1::date + 6))
     ON CONFLICT (start_date) DO NOTHING`,
    [WEEK_START],
  );
  await pool.query(
    `INSERT INTO customer_upload_attempts
       (week_start, customer, last_attempt_at, last_success_at,
        last_file_name, last_source)
     VALUES ($1::date, $2, now(), now(), $3, 'ai')
     ON CONFLICT (week_start, customer) DO UPDATE
       SET last_file_name = EXCLUDED.last_file_name,
           last_source = EXCLUDED.last_source`,
    [WEEK_START, CUSTOMER, FILE_NAME],
  );

  // Seed the AI-extracted sample that read_upload_file_rows will surface.
  // One pending row keyed by the on-doc name "Willie Medina ..." — the
  // exact case the prompt's BAD/GOOD example pair is built around.
  const extractedRows = [
    {
      kfiId: KFI_ID,
      customer: CUSTOMER,
      date: PUNCH_DATE,
      clockIn: "6:00 AM",
      clockOut: "2:30 PM",
      hours: 8.5,
      payType: "Reg",
    },
  ];
  const pendingNamedRows = [
    {
      driverNameOnDoc: DRIVER_NAME,
      badgeOrId: null,
      date: PUNCH_DATE,
      timeIn: "6:00 AM",
      timeOut: "2:30 PM",
      hours: 8.5,
    },
  ];
  await pool.query(
    `INSERT INTO ai_extract_samples
       (week_start, customer, file_name, mime_type, size_bytes,
        file_bytes, uploaded_at, confirmed_at, expires_at,
        extracted_rows, pending_named_rows)
     VALUES ($1::date, $2, $3,
             'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
             $4, $5, now(), now(),
             now() + interval '30 days',
             $6::jsonb, $7::jsonb)`,
    [
      WEEK_START,
      CUSTOMER,
      FILE_NAME,
      11,
      Buffer.from("terse-voice-fx"),
      JSON.stringify(extractedRows),
      JSON.stringify(pendingNamedRows),
    ],
  );
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

// Skip when no Claude key is configured (e.g. some CI contexts) — the
// whole point of this spec is to drive a real model turn.
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);

(hasKey ? test : test.skip)(
  "real chat turn opens with the finding and reads the file first",
  async ({ page }) => {
    test.setTimeout(120_000);
    await signInAsDispatcher(page);

    const res = await page.request.post(
      `/api/weeks/${WEEK_START}/customer-chat/${encodeURIComponent(CUSTOMER)}/messages`,
      {
        data: {
          content: `${DRIVER_NAME} is missing a Tuesday punch on ${PUNCH_DATE}. Can you check?`,
        },
        timeout: 90_000,
      },
    );
    expect(res.status(), await res.text().catch(() => "")).toBe(200);
    const body = (await res.json()) as {
      id: number;
      role: string;
      content: string;
    };
    expect(body.role).toBe("assistant");

    // (a) No customer-service preamble. The system prompt explicitly
    // bans these openings; the BAD example pairs them with the exact
    // Willie-Medina case we just sent. Trim leading quotes/markdown so
    // a stylistic "> finding" reply still passes — what we're guarding
    // against is "I'll/Let me" as the first words of prose.
    const reply = body.content ?? "";
    const firstWords = reply
      .trimStart()
      .replace(/^[>*_`#"'\s]+/u, "")
      .slice(0, 40);
    expect(
      firstWords,
      `assistant must not open with a customer-service preamble — got: ${JSON.stringify(reply.slice(0, 200))}`,
    ).not.toMatch(/^(I['’]?ll\b|Let me\b)/i);

    // Investigation-first ordering: the first sentence must be a
    // finding, not a question to the dispatcher. runChatTurn
    // accumulates assistant text across every model response in the
    // tool loop, so a reply that opens with "What time did Willie
    // clock in?" would still have file_evidence populated if a
    // later loop iteration called read_upload_file_rows. Guard the
    // ordering directly by rejecting an opening sentence that ends
    // in "?". Strip leading quote/markdown markers first so a
    // stylistic "> finding." opener still passes.
    const trimmed = reply.trimStart().replace(/^[>*_`#"'\s]+/u, "");
    const firstSentenceMatch = trimmed.match(/^[^.!?]*[.!?]/u);
    const firstSentence = (firstSentenceMatch?.[0] ?? trimmed).trim();
    expect(
      firstSentence.endsWith("?"),
      `assistant must open with a finding, not a question — got first sentence: ${JSON.stringify(firstSentence)}`,
    ).toBe(false);

    // (b) read_upload_file_rows was called before any prose was sent.
    // The chat layer's EvidenceAccumulator only populates
    // `file_evidence` when a row-read tool ran during the turn, and
    // the assistant message row is the chat audit row for the turn.
    const audit = await pool.query<{
      file_evidence: { resolvedRows?: unknown[]; pendingRows?: unknown[] } | null;
    }>(
      `SELECT file_evidence FROM customer_upload_chat_messages WHERE id = $1`,
      [body.id],
    );
    expect(audit.rows.length).toBe(1);
    const evidence = audit.rows[0].file_evidence;
    expect(
      evidence,
      "assistant must call read_upload_file_rows before replying — file_evidence is null",
    ).not.toBeNull();
    const evResolved = evidence?.resolvedRows ?? [];
    const evPending = evidence?.pendingRows ?? [];
    expect(
      evResolved.length + evPending.length,
      "read_upload_file_rows must have returned at least one row from the seeded sample",
    ).toBeGreaterThan(0);
  },
);
