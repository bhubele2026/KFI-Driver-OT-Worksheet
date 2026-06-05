/**
 * Opt-in, env-gated LIVE end-to-end coverage for the Worksheet Copilot
 * (artifacts/api-server/src/lib/copilot/* + routes/copilot.ts).
 *
 * Unlike the unit tests in
 * `artifacts/api-server/src/lib/copilot/__tests__/`, which stub the
 * Anthropic client, this spec drives a *real* Claude turn through the
 * running api-server's HTTP routes. A real model chooses tools, grounds
 * itself with a read, and then either performs a non-destructive write
 * directly (add a manual punch) or parks a destructive action
 * (delete a punch) for the dispatcher to confirm / reject. The whole
 * read → tool-choice → loopback-mutation → confirm/cancel path is
 * exercised against the dev database.
 *
 * Because it calls a live model it is non-deterministic and costs money,
 * so it is SKIPPED by default. To run it locally:
 *
 *   KFI_COPILOT_LIVE=1 KFI_E2E_ALLOW_DB=1 \
 *     pnpm --filter @workspace/kfi-ot run test:e2e copilot-live
 *
 * Prerequisites (none of which touch prod):
 *   - ANTHROPIC_API_KEY set (the copilot calls Claude with it).
 *   - DATABASE_URL pointing at the dev DB. The shared e2e DB guard in
 *     `_helpers/db.ts` HARD-REFUSES anything that is not on the dev
 *     allow-list (helium/heliumdb, localhost), so this can never seed or
 *     mutate the production database even if the flags are set by mistake.
 *   - The api-server + web workflows running (the loopback calls the
 *     api-server on its own PORT; the spec talks to the proxy on :80).
 *
 * Never set KFI_COPILOT_LIVE / KFI_E2E_ALLOW_DB in the production
 * environment. With the flags unset the entire file no-ops, so the
 * pre-merge gate stays deterministic and free.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { createE2EPool } from "./_helpers/db";
import { signInAsDispatcher } from "./_helpers/auth";

const LIVE =
  process.env.KFI_COPILOT_LIVE === "1" && !!process.env.ANTHROPIC_API_KEY;

// Skip the whole file (and its hooks) unless explicitly opted in.
test.skip(
  !LIVE,
  "live Copilot test — set KFI_COPILOT_LIVE=1 and ANTHROPIC_API_KEY to run",
);

// Live multi-step Opus turns are slow; give each scenario generous room.
test.describe.configure({ timeout: 240_000 });
const TURN_TIMEOUT_MS = 200_000;

const WEEK_START = "2032-05-09"; // a Sunday
const WEEK_END = "2032-05-15";
const SUFFIX = `e2e-cp-${Date.now().toString(36)}`;
const DRIVER = {
  kfiId: `KFI-CP-${SUFFIX}`,
  name: "Copilot Live Tester",
  customer: "Adient",
};

let pool: ReturnType<typeof createE2EPool>;
const createdConversationIds: number[] = [];

async function seedWeekAndDriver(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO weeks (start_date, end_date) VALUES ($1, $2)
       ON CONFLICT (start_date) DO NOTHING`,
      [WEEK_START, WEEK_END],
    );
    await client.query(
      `INSERT INTO drivers (kfi_id, name, customer) VALUES ($1, $2, $3)
       ON CONFLICT (kfi_id) DO UPDATE
         SET name = EXCLUDED.name, customer = EXCLUDED.customer`,
      [DRIVER.kfiId, DRIVER.name, DRIVER.customer],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Insert a single manual Driver-source punch and return its id. */
async function seedPunch(date: string, hours: number): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO punches
       (week_start, kfi_id, customer, source, date,
        clock_in, clock_out, hours, is_manual)
     VALUES ($1::date, $2, $3, 'Driver', $4,
             $5, $6, $7, true)
     RETURNING id`,
    [
      WEEK_START,
      DRIVER.kfiId,
      DRIVER.customer,
      date,
      `${date} 8:00 AM`,
      `${date} 4:00 PM`,
      hours,
    ],
  );
  return rows[0].id;
}

async function countPunches(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM punches WHERE week_start = $1 AND kfi_id = $2`,
    [WEEK_START, DRIVER.kfiId],
  );
  return Number(rows[0].n);
}

async function punchExists(id: number): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM punches WHERE id = $1`, [id]);
  return rows.length > 0;
}

interface AssistantMessage {
  id: number;
  conversationId: number;
  role: string;
  content: string;
  toolSteps:
    | Array<{ tool: string; ok: boolean; mutating: boolean; summary?: string }>
    | null;
  pendingAction: { kind: string; calls: unknown[] } | null;
  actionStatus: string | null;
  actionResult: { ok: boolean } | null;
}

/** Start a fresh conversation with one dispatcher message and run the turn. */
async function runTurn(
  request: APIRequestContext,
  message: string,
): Promise<AssistantMessage> {
  const res = await request.post("/api/copilot/conversations", {
    data: {
      message,
      context: { weekStart: WEEK_START, kfiId: DRIVER.kfiId },
    },
    timeout: TURN_TIMEOUT_MS,
  });
  expect(
    res.ok(),
    `copilot turn failed: ${res.status()} ${await res.text().catch(() => "")}`,
  ).toBeTruthy();
  const body = (await res.json()) as {
    conversation: { id: number };
    message: AssistantMessage;
  };
  createdConversationIds.push(body.conversation.id);
  return body.message;
}

test.beforeAll(async () => {
  pool = createE2EPool();
  await cleanup();
  await seedWeekAndDriver();
});

async function cleanup(): Promise<void> {
  if (!pool) return;
  await pool.query(`DELETE FROM punches WHERE week_start = $1 AND kfi_id = $2`, [
    WEEK_START,
    DRIVER.kfiId,
  ]);
  await pool.query(
    `DELETE FROM punch_deletions WHERE week_start = $1 AND kfi_id = $2`,
    [WEEK_START, DRIVER.kfiId],
  );
  await pool.query(
    `DELETE FROM reviewed_drivers WHERE week_start = $1 AND kfi_id = $2`,
    [WEEK_START, DRIVER.kfiId],
  );
  await pool.query(`DELETE FROM weeks WHERE start_date = $1`, [WEEK_START]);
  await pool.query(`DELETE FROM drivers WHERE kfi_id = $1`, [DRIVER.kfiId]);
}

test.afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await pool.query(
      `DELETE FROM copilot_messages WHERE conversation_id = ANY($1::int[])`,
      [createdConversationIds],
    );
    await pool.query(`DELETE FROM copilot_conversations WHERE id = ANY($1::int[])`, [
      createdConversationIds,
    ]);
  }
  await cleanup();
  await pool.end();
});

test("a live Copilot turn reads the driver-week and adds a manual punch", async ({
  page,
}) => {
  await signInAsDispatcher(page);
  const before = await countPunches();
  expect(before).toBe(0);

  const date = "2032-05-11"; // Tuesday within the week
  const message = await runTurn(
    page.request,
    `Add a manual punch for driver ${DRIVER.kfiId} on ${date} from 8:00 AM to 4:00 PM. ` +
      `Just do it — this is a routine non-destructive add, no confirmation needed.`,
  );

  // The model should have grounded with a read, then performed the write
  // directly (add_manual_punch is non-gated). The authoritative check is
  // the DB: exactly one punch now exists for the driver-week.
  expect(message.pendingAction, "a manual add must not be gated").toBeNull();
  const after = await countPunches();
  expect(after).toBe(1);

  const { rows } = await pool.query<{ date: string; source: string }>(
    `SELECT date, source FROM punches WHERE week_start = $1 AND kfi_id = $2`,
    [WEEK_START, DRIVER.kfiId],
  );
  expect(rows[0].date).toBe(date);

  // The trail should show a successful mutating add step.
  const steps = message.toolSteps ?? [];
  expect(
    steps.some((s) => s.tool === "add_manual_punch" && s.ok && s.mutating),
    `expected a successful add_manual_punch step, got: ${JSON.stringify(steps)}`,
  ).toBeTruthy();
});

test("a parked delete is executed only after the dispatcher confirms", async ({
  page,
}) => {
  await signInAsDispatcher(page);
  const punchId = await seedPunch("2032-05-12", 8);

  const message = await runTurn(
    page.request,
    `Delete the punch with id ${punchId} for driver ${DRIVER.kfiId} ` +
      `in the week of ${WEEK_START}. The reason is that it is a duplicate entry.`,
  );

  // The delete must be parked, not executed inline.
  expect(message.pendingAction?.kind).toBe("delete_punch");
  expect(message.actionStatus).toBe("pending");
  expect(await punchExists(punchId), "punch must survive until confirmed").toBe(
    true,
  );

  // Confirm — the route replays the gated DELETE through the loopback.
  const confirmRes = await page.request.post(
    `/api/copilot/conversations/${message.conversationId}/messages/${message.id}/confirm`,
    { timeout: TURN_TIMEOUT_MS },
  );
  expect(confirmRes.ok()).toBeTruthy();
  const confirmed = (await confirmRes.json()) as { message: AssistantMessage };
  expect(confirmed.message.actionStatus).toBe("executed");
  expect(confirmed.message.actionResult?.ok).toBe(true);
  expect(await punchExists(punchId), "punch must be deleted after confirm").toBe(
    false,
  );
});

test("a parked delete is preserved when the dispatcher rejects it", async ({
  page,
}) => {
  await signInAsDispatcher(page);
  const punchId = await seedPunch("2032-05-13", 8);

  const message = await runTurn(
    page.request,
    `Delete the punch with id ${punchId} for driver ${DRIVER.kfiId} ` +
      `in the week of ${WEEK_START}. The reason is that it is a duplicate entry.`,
  );

  expect(message.pendingAction?.kind).toBe("delete_punch");
  expect(message.actionStatus).toBe("pending");

  // Reject — the punch must remain untouched.
  const cancelRes = await page.request.post(
    `/api/copilot/conversations/${message.conversationId}/messages/${message.id}/cancel`,
  );
  expect(cancelRes.ok()).toBeTruthy();
  const cancelled = (await cancelRes.json()) as { message: AssistantMessage };
  expect(cancelled.message.actionStatus).toBe("cancelled");
  expect(
    await punchExists(punchId),
    "punch must survive a rejected delete",
  ).toBe(true);
});
