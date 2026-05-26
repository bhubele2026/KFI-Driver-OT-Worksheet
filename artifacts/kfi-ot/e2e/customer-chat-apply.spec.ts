/**
 * Task #406 (T007): end-to-end coverage for the per-customer Claude
 * chat apply flow.
 *
 * We can't drive a real Claude tool loop from CI (no key, no network),
 * so the spec seeds a chat message with a `proposedFix` payload
 * directly into the DB — exactly the row shape the Claude chat layer
 * would have written — and then exercises the apply route end-to-end:
 *
 *   1. Insert a driver row, a chat thread, and an assistant message
 *      carrying a `addPunches` proposed fix.
 *   2. POST `/api/weeks/.../customer-chat/.../messages/:id/apply` with
 *      a `lessonText` override.
 *   3. Verify a Customer-source punch landed in `punches`, the chat
 *      message was stamped `applied_at`, and a row appeared in
 *      `customer_extraction_lessons` for the same customer.
 *   4. Re-applying returns 409.
 *
 * The dismiss path is covered for a second seeded message: dismissing
 * stamps `dismissed_at` and re-dismiss returns 409.
 */
import { test, expect } from "@playwright/test";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";

const pool = createE2EPool();

const SUFFIX = `e2e-${Date.now().toString(36)}`;
const CUSTOMER = `ZZZ-Chat-${SUFFIX}`;
const KFI_ID = `ZZZ${SUFFIX.slice(0, 6)}`;
const WEEK_START = "2031-05-04"; // Sunday in 2031 — disposable in dev DB
const PUNCH_DATE = "2031-05-06"; // Tuesday in the same week

let driverInserted = false;
let chatId: number | null = null;

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM punches WHERE kfi_id = $1`, [KFI_ID]);
  await pool.query(
    `DELETE FROM customer_extraction_lessons WHERE customer = $1`,
    [CUSTOMER],
  );
  // chat messages cascade with the parent chat.
  await pool.query(`DELETE FROM customer_upload_chats WHERE customer = $1`, [
    CUSTOMER,
  ]);
  if (driverInserted) {
    await pool.query(`DELETE FROM drivers WHERE kfi_id = $1`, [KFI_ID]);
  }
}

test.beforeAll(async () => {
  await cleanup();
  // Insert a driver row so the apply route's loadDriverTz / resolveDispTz
  // path resolves cleanly.
  await pool.query(
    `INSERT INTO drivers (kfi_id, name, customer)
     VALUES ($1, $2, $3)
     ON CONFLICT (kfi_id) DO NOTHING`,
    [KFI_ID, `E2E Chat Driver ${SUFFIX}`, CUSTOMER],
  );
  driverInserted = true;
  // Seed the week row — end_date is NOT NULL and = start_date + 6 days
  // (Sun→Sat payroll week).
  await pool.query(
    `INSERT INTO weeks (start_date, end_date)
     VALUES ($1::date, ($1::date + 6))
     ON CONFLICT (start_date) DO NOTHING`,
    [WEEK_START],
  );
  const chatRow = await pool.query<{ id: number }>(
    `INSERT INTO customer_upload_chats (week_start, customer)
     VALUES ($1::date, $2) RETURNING id`,
    [WEEK_START, CUSTOMER],
  );
  chatId = chatRow.rows[0].id;
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("apply addPunches creates the punch and saves the lesson", async ({
  page,
}) => {
  await signInAsDispatcher(page);

  const fix = {
    kind: "addPunches",
    punches: [
      {
        kfiId: KFI_ID,
        date: PUNCH_DATE,
        clockIn: "7:00 AM",
        clockOut: "3:30 PM",
        payType: "Reg",
      },
    ],
  };
  const msgRow = await pool.query<{ id: number }>(
    `INSERT INTO customer_upload_chat_messages
       (chat_id, role, content, proposed_fix, proposed_lesson)
     VALUES ($1, 'assistant', $2, $3::jsonb, $4)
     RETURNING id`,
    [chatId, "Add Tuesday for that driver.", JSON.stringify(fix), null],
  );
  const messageId = msgRow.rows[0].id;

  const res = await page.request.post(
    `/api/weeks/${WEEK_START}/customer-chat/${encodeURIComponent(CUSTOMER)}/messages/${messageId}/apply`,
    { data: { lessonText: "Acme drops Tuesday from the file." } },
  );
  expect(res.status(), await res.text().catch(() => "")).toBe(200);
  const body = await res.json();
  expect(body.summary).toMatch(/Added 1 punch/);
  expect(body.lesson).not.toBeNull();
  expect(body.lesson.lessonText).toBe("Acme drops Tuesday from the file.");

  const punches = await pool.query(
    `SELECT customer, source, date, hours FROM punches
     WHERE kfi_id = $1 AND week_start = $2::date`,
    [KFI_ID, WEEK_START],
  );
  expect(punches.rows.length).toBe(1);
  expect(punches.rows[0].customer).toBe(CUSTOMER);
  expect(punches.rows[0].source).toBe("Customer");
  expect(String(punches.rows[0].date)).toContain(PUNCH_DATE);
  expect(Number(punches.rows[0].hours)).toBeCloseTo(8.5, 2);

  const lessons = await pool.query(
    `SELECT lesson_text, active, created_from_chat_message_id
     FROM customer_extraction_lessons WHERE customer = $1`,
    [CUSTOMER],
  );
  expect(lessons.rows.length).toBe(1);
  expect(lessons.rows[0].active).toBe(true);
  expect(lessons.rows[0].created_from_chat_message_id).toBe(messageId);

  const msg = await pool.query<{ applied_at: Date | null }>(
    `SELECT applied_at FROM customer_upload_chat_messages WHERE id = $1`,
    [messageId],
  );
  expect(msg.rows[0].applied_at).not.toBeNull();

  // Re-applying must 409.
  const dup = await page.request.post(
    `/api/weeks/${WEEK_START}/customer-chat/${encodeURIComponent(CUSTOMER)}/messages/${messageId}/apply`,
    { data: {} },
  );
  expect(dup.status()).toBe(409);
});

test("dismiss stamps dismissed_at and re-dismiss returns 409", async ({
  page,
}) => {
  await signInAsDispatcher(page);

  const fix = {
    kind: "addDriverAlias",
    nameOnDoc: `Doc Name ${SUFFIX}`,
    kfiId: KFI_ID,
  };
  const msgRow = await pool.query<{ id: number }>(
    `INSERT INTO customer_upload_chat_messages
       (chat_id, role, content, proposed_fix)
     VALUES ($1, 'assistant', $2, $3::jsonb)
     RETURNING id`,
    [chatId, "Save this alias.", JSON.stringify(fix)],
  );
  const messageId = msgRow.rows[0].id;

  const res = await page.request.post(
    `/api/weeks/${WEEK_START}/customer-chat/${encodeURIComponent(CUSTOMER)}/messages/${messageId}/dismiss`,
  );
  expect(res.status()).toBe(200);
  const dismissed = await pool.query<{ dismissed_at: Date | null }>(
    `SELECT dismissed_at FROM customer_upload_chat_messages WHERE id = $1`,
    [messageId],
  );
  expect(dismissed.rows[0].dismissed_at).not.toBeNull();

  const dup = await page.request.post(
    `/api/weeks/${WEEK_START}/customer-chat/${encodeURIComponent(CUSTOMER)}/messages/${messageId}/dismiss`,
  );
  expect(dup.status()).toBe(409);
});
