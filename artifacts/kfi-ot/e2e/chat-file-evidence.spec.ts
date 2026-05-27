/**
 * Task #423: end-to-end coverage for the "Evidence from file" block
 * that Task #420 added to the per-customer Claude chat drawer.
 *
 * We can't drive a real Claude tool loop from CI (no API key, no
 * network), so — following the same pattern as
 * `customer-chat-apply.spec.ts` — this spec seeds the row shape the
 * Claude chat layer would have written: an `ai_extract_samples` row
 * (the stashed upload the `read_upload_file_rows` tool reads from),
 * plus an assistant chat message carrying both a `proposed_fix` and
 * the `file_evidence` payload the tool's `EvidenceAccumulator` would
 * have built from those rows.
 *
 * It then drives the dashboard: opens the chat drawer for the
 * seeded customer-week and asserts:
 *   - the `chat-file-evidence` block renders beside the proposed-fix card,
 *   - the resolved sub-table contains the seeded driver / date / in / out,
 *   - the pending sub-table contains the still-unaliased name-on-doc.
 *
 * Per the e2e DB-safety contract, all DB access goes through
 * `createE2EPool()`.
 */
import { test, expect } from "@playwright/test";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";

const pool = createE2EPool();

const SUFFIX = `e2e-${Date.now().toString(36)}`;
const CUSTOMER = `ZZZ-Evidence-${SUFFIX}`;
const KFI_ID = `ZZE${SUFFIX.slice(0, 6)}`;
const DRIVER_NAME = `Evidence Driver ${SUFFIX}`;
const WEEK_START = "2031-05-11"; // Sunday — disposable in dev DB
const PUNCH_DATE = "2031-05-13"; // Tuesday in that week
const FILE_NAME = `evidence-${SUFFIX}.xlsx`;

let chatId: number | null = null;

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

  // Driver assigned to our throw-away customer (defaults `is_archived=false`,
  // so the customer-uploads panel will surface a row for it).
  await pool.query(
    `INSERT INTO drivers (kfi_id, name, customer)
     VALUES ($1, $2, $3)
     ON CONFLICT (kfi_id) DO NOTHING`,
    [KFI_ID, DRIVER_NAME, CUSTOMER],
  );

  // Sun→Sat payroll week row.
  await pool.query(
    `INSERT INTO weeks (start_date, end_date)
     VALUES ($1::date, ($1::date + 6))
     ON CONFLICT (start_date) DO NOTHING`,
    [WEEK_START],
  );

  // Upload-attempt row makes the customer row appear in the
  // CustomerUploadPanel (one of the activity signals — see
  // `hasActivityThisWeek` in `weeksRouter.get("/customer-uploads")`).
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

  // The stashed sample the read_upload_file_rows tool would have read.
  // Includes one resolved row (kfiId already mapped) and one pending row
  // (name-on-doc not yet aliased) — both of these flow into the evidence
  // block sub-tables in the UI.
  const extractedRows = [
    {
      kfiId: KFI_ID,
      customer: CUSTOMER,
      date: PUNCH_DATE,
      clockIn: "7:00 AM",
      clockOut: "3:30 PM",
      hours: 8.5,
      payType: "Reg",
    },
  ];
  const pendingNamedRows = [
    {
      driverNameOnDoc: `J. Unaliased ${SUFFIX}`,
      badgeOrId: null,
      date: PUNCH_DATE,
      timeIn: "8:00 AM",
      timeOut: "4:00 PM",
      hours: 8,
    },
  ];
  const sampleRow = await pool.query<{ id: number }>(
    `INSERT INTO ai_extract_samples
       (week_start, customer, file_name, mime_type, size_bytes,
        file_bytes, uploaded_at, confirmed_at, expires_at,
        extracted_rows, pending_named_rows)
     VALUES ($1::date, $2, $3,
             'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
             $4, $5, now(), now(),
             now() + interval '30 days',
             $6::jsonb, $7::jsonb)
     RETURNING id`,
    [
      WEEK_START,
      CUSTOMER,
      FILE_NAME,
      11,
      Buffer.from("evidence-fx"),
      JSON.stringify(extractedRows),
      JSON.stringify(pendingNamedRows),
    ],
  );
  const sampleId = sampleRow.rows[0].id;

  // Chat thread for the customer-week.
  const chatRow = await pool.query<{ id: number }>(
    `INSERT INTO customer_upload_chats (week_start, customer)
     VALUES ($1::date, $2) RETURNING id`,
    [WEEK_START, CUSTOMER],
  );
  chatId = chatRow.rows[0].id;

  // User turn — present so the chat reads like a real exchange in the drawer.
  await pool.query(
    `INSERT INTO customer_upload_chat_messages (chat_id, role, content)
     VALUES ($1, 'user', $2)`,
    [chatId, `Is ${DRIVER_NAME} missing Tuesday?`],
  );

  // Assistant turn carrying the structured proposed fix AND the
  // file_evidence payload the EvidenceAccumulator would have built
  // from the read_upload_file_rows call(s) on this turn. Shape matches
  // `FileEvidence` in lib/db/src/schema/customerUploadChats.ts.
  const proposedFix = {
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
  const fileEvidence = {
    sampleId,
    fileName: FILE_NAME,
    resolvedRows: [
      {
        kfiId: KFI_ID,
        driverName: DRIVER_NAME,
        date: PUNCH_DATE,
        clockIn: "7:00 AM",
        clockOut: "3:30 PM",
        hours: 8.5,
        payType: "Reg",
      },
    ],
    pendingRows: [
      {
        driverNameOnDoc: `J. Unaliased ${SUFFIX}`,
        badgeOrId: null,
        date: PUNCH_DATE,
        timeIn: "8:00 AM",
        timeOut: "4:00 PM",
        hours: 8,
      },
    ],
  };
  await pool.query(
    `INSERT INTO customer_upload_chat_messages
       (chat_id, role, content, proposed_fix, file_evidence)
     VALUES ($1, 'assistant', $2, $3::jsonb, $4::jsonb)`,
    [
      chatId,
      `Yes — the uploaded file shows ${DRIVER_NAME} on ${PUNCH_DATE}. Proposing to add it.`,
      JSON.stringify(proposedFix),
      JSON.stringify(fileEvidence),
    ],
  );
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test("Evidence from file block renders the resolved and pending rows", async ({
  page,
}) => {
  await signInAsDispatcher(page);
  await page.goto(`/weeks/${WEEK_START}`);

  // The customer row appears in the upload panel once the week summary
  // query resolves. Wait for it before clicking the chat-open button.
  const openChat = page.getByTestId(`customer-chat-open-${CUSTOMER}`);
  await expect(openChat).toBeVisible({ timeout: 30_000 });
  await openChat.click();

  const drawer = page.getByTestId("customer-chat-drawer");
  await expect(drawer).toBeVisible();

  // Drawer fetches the seeded thread; the assistant proposed-fix card
  // renders the FileEvidenceBlock right under the JSON preview.
  const evidence = drawer.getByTestId("chat-file-evidence");
  await expect(evidence).toBeVisible({ timeout: 15_000 });
  await expect(evidence).toContainText("Evidence from file");
  await expect(evidence).toContainText("2 rows");
  await expect(evidence).toContainText(FILE_NAME);

  // Default-open when total rows <= 3, so both sub-tables should be
  // present without clicking the toggle. Defensive: if a future change
  // flips that default, click to expand.
  let resolved = evidence.getByTestId("chat-file-evidence-resolved");
  if ((await resolved.count()) === 0) {
    await evidence.getByTestId("chat-file-evidence-toggle").click();
    resolved = evidence.getByTestId("chat-file-evidence-resolved");
  }
  await expect(resolved).toBeVisible();
  await expect(resolved).toContainText(DRIVER_NAME);
  await expect(resolved).toContainText(PUNCH_DATE);
  await expect(resolved).toContainText("7:00 AM");
  await expect(resolved).toContainText("3:30 PM");
  await expect(resolved).toContainText("8.5");

  const pending = evidence.getByTestId("chat-file-evidence-pending");
  await expect(pending).toBeVisible();
  await expect(pending).toContainText(`J. Unaliased ${SUFFIX}`);
  await expect(pending).toContainText("8:00 AM");
  await expect(pending).toContainText("4:00 PM");

  // Collapse + re-expand exercises the toggle so a regression that
  // breaks the open/close state would fail here.
  const toggle = evidence.getByTestId("chat-file-evidence-toggle");
  await toggle.click();
  await expect(
    evidence.getByTestId("chat-file-evidence-resolved"),
  ).toHaveCount(0);
  await toggle.click();
  await expect(
    evidence.getByTestId("chat-file-evidence-resolved"),
  ).toBeVisible();
});
