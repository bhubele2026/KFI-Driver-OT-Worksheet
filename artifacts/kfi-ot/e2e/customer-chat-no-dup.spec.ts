/**
 * Task #428: end-to-end coverage for the "user message renders exactly
 * once" contract in the per-customer Claude chat drawer.
 *
 * We can't drive a real Claude tool loop from CI (no API key, no
 * network), so this spec seeds the customer-week the same way
 * `customer-chat-apply.spec.ts` does (driver + week + upload attempt
 * + chat rows), then uses `page.route()` to stub:
 *
 *   - GET  /api/weeks/:w/customer-chat/:c          → returns the
 *     in-memory `persisted[]` array, NOT what's in the DB. The seeded
 *     thread is just there to make the chat-open affordance appear
 *     on the dashboard.
 *
 *   - POST /api/weeks/:w/customer-chat/:c/messages → simulates the
 *     server's actual behavior: persists the user turn immediately,
 *     pauses for ~600ms to mimic the Claude round-trip, then returns
 *     and persists the assistant message.
 *
 * Acceptance: after sending, exactly one user bubble renders
 * immediately (optimistic), and still exactly one after the assistant
 * reply lands (no duplicate from the post-settle refetch).
 */
import { test, expect, type Route } from "@playwright/test";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";

const pool = createE2EPool();

const SUFFIX = `e2e-${Date.now().toString(36)}`;
const CUSTOMER = `ZZZ-NoDup-${SUFFIX}`;
const KFI_ID = `ZZN${SUFFIX.slice(0, 6)}`;
const DRIVER_NAME = `NoDup Driver ${SUFFIX}`;
const WEEK_START = "2031-05-04"; // Sunday — disposable
const FILE_NAME = `nodup-${SUFFIX}.xlsx`;

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM punches WHERE kfi_id = $1`, [KFI_ID]);
  await pool.query(`DELETE FROM customer_upload_chats WHERE customer = $1`, [
    CUSTOMER,
  ]);
  await pool.query(
    `DELETE FROM customer_upload_attempts WHERE customer = $1`,
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
});

test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

type StubMsg = {
  id: number;
  chatId: number;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  proposedFix: null;
  proposedLesson: null;
  fileEvidence: null;
  appliedAt: null;
  appliedByEmail: null;
  dismissedAt: null;
  dismissedByEmail: null;
  authorEmail: null;
};

test("user bubble renders exactly once, before and after the assistant reply lands", async ({
  page,
}) => {
  await signInAsDispatcher(page);

  const persisted: StubMsg[] = [];
  let nextId = 1000;
  const chatId = 9999;
  const customerEncoded = encodeURIComponent(CUSTOMER);
  const escaped = customerEncoded.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const threadUrl = new RegExp(
    `/api/weeks/${WEEK_START}/customer-chat/${escaped}(?:\\?|$)`,
  );
  const postUrl = new RegExp(
    `/api/weeks/${WEEK_START}/customer-chat/${escaped}/messages(?:\\?|$)`,
  );

  await page.route(threadUrl, async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        chat: {
          id: chatId,
          weekStart: WEEK_START,
          customer: CUSTOMER,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        messages: persisted,
        lessons: [],
        customerPunchCount: 0,
        lastFileName: FILE_NAME,
        lockedKfiIds: [],
      }),
    });
  });

  await page.route(postUrl, async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as { content?: string };
    const content = String(body?.content ?? "");
    // Mirror the real server: persist the user turn immediately,
    // before "Claude" runs.
    persisted.push({
      id: nextId++,
      chatId,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
      proposedFix: null,
      proposedLesson: null,
      fileEvidence: null,
      appliedAt: null,
      appliedByEmail: null,
      dismissedAt: null,
      dismissedByEmail: null,
      authorEmail: null,
    });
    await new Promise((r) => setTimeout(r, 600));
    const assistant: StubMsg = {
      id: nextId++,
      chatId,
      role: "assistant",
      content: `Got it — looking into ${content.slice(0, 30)}`,
      createdAt: new Date().toISOString(),
      proposedFix: null,
      proposedLesson: null,
      fileEvidence: null,
      appliedAt: null,
      appliedByEmail: null,
      dismissedAt: null,
      dismissedByEmail: null,
      authorEmail: null,
    };
    persisted.push(assistant);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(assistant),
    });
  });

  await page.goto(`/weeks/${WEEK_START}`);

  const openChat = page.getByTestId(`customer-chat-open-${CUSTOMER}`);
  await expect(openChat).toBeVisible({ timeout: 30_000 });
  await openChat.click();

  const drawer = page.getByTestId("customer-chat-drawer");
  await expect(drawer).toBeVisible();

  const prompt = `Driver ${KFI_ID} is missing Tuesday`;
  await drawer.getByTestId("customer-chat-input").fill(prompt);
  await drawer.getByTestId("customer-chat-send").click();

  // Optimistic user bubble shows immediately — count is exactly 1.
  const userBubbles = drawer
    .locator("[data-testid^='chat-message-']")
    .filter({ hasText: prompt });
  await expect(userBubbles).toHaveCount(1);

  // Wait for the assistant reply to render (post-settle refetch
  // brings in persisted [user, assistant] from the GET stub).
  await expect(
    drawer
      .locator("[data-testid^='chat-message-']")
      .filter({ hasText: "Got it — looking into" }),
  ).toHaveCount(1, { timeout: 10_000 });

  // After the refetch settles, the user bubble must still be 1.
  // Without the dedupe in chatDedupe.ts the optimistic + server
  // copies would render as two separate bubbles here.
  await expect(userBubbles).toHaveCount(1);
});
