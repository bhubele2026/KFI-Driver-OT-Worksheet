import test from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";

const ALLOWED_HOSTS = new Set(["helium", "localhost", "127.0.0.1"]);
const ALLOWED_DB_NAMES = new Set(["heliumdb"]);

function allowedDbOrSkip(): boolean {
  if (process.env.KFI_E2E_ALLOW_DB !== "1") return false;
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  try {
    const u = new URL(url);
    return (
      ALLOWED_HOSTS.has(u.hostname) &&
      ALLOWED_DB_NAMES.has(u.pathname.replace(/^\//, ""))
    );
  } catch {
    return false;
  }
}

if (!allowedDbOrSkip()) {
  test("runUploadAnalysis (DB-gated, skipped)", { skip: true }, () => {});
} else {
  const { db, schema } = await import("../../db.js");
  const { eq, sql } = await import("drizzle-orm");
  const {
    runUploadAnalysis,
    _setClientFactoryForTests,
    _resetClientFactoryForTests,
  } = await import("../runAnalysis.js");
  const { PROMPT_VERSION, SUBMIT_ANALYSIS_TOOL_NAME } = await import(
    "../contract.js"
  );

  type FakeResponse = {
    content: Anthropic.Messages.ContentBlock[];
    stop_reason: string | null;
    usage: { input_tokens: number; output_tokens: number };
  };

  function makeClient(scripted: FakeResponse[]): {
    messages: { create: (...args: unknown[]) => Promise<FakeResponse> };
    calls: number;
  } {
    let i = 0;
    const obj = {
      messages: {
        create: async () => {
          const r = scripted[i++];
          if (!r) throw new Error("scripted client ran out of responses");
          return r;
        },
      },
      calls: 0,
    };
    return obj;
  }

  async function seedSample(customer: string): Promise<{
    sampleId: number;
    weekStart: string;
    fileName: string;
  }> {
    const weekStart = "2026-01-04";
    const fileName = `runAnalysis-test-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.xlsx`;
    await db
      .insert(schema.weeksTable)
      .values({ startDate: weekStart, endDate: "2026-01-10" })
      .onConflictDoNothing();
    const ins = await db
      .insert(schema.aiExtractSamplesTable)
      .values({
        weekStart,
        customer,
        fileName,
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 4,
        fileBytes: Buffer.from("test"),
        extractedRows: [],
        pendingNamedRows: null,
        droppedRows: [],
        confirmedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: schema.aiExtractSamplesTable.id });
    return { sampleId: ins[0]!.id, weekStart, fileName };
  }

  async function cleanup(sampleId: number): Promise<void> {
    await db
      .delete(schema.uploadAnalysisVerdictsTable)
      .where(eq(schema.uploadAnalysisVerdictsTable.sampleId, sampleId));
    await db
      .delete(schema.aiExtractSamplesTable)
      .where(eq(schema.aiExtractSamplesTable.id, sampleId));
  }

  test("runUploadAnalysis persists a clean verdict and parsed findings", async () => {
    const { sampleId, weekStart, fileName } = await seedSample(
      `RunAnalysisTest_${Date.now()}`,
    );
    const verdictPayload = {
      verdict: "warn",
      lane: "parser",
      summary: "One driver had an unusual 14h day; double-check.",
      findings: [
        {
          kind: "hours_anomaly",
          severity: "warn",
          message: "Driver X clocked 14h on 2026-01-05.",
          evidence: { driver: "Driver X", date: "2026-01-05" },
        },
      ],
    };
    const client = makeClient([
      {
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: SUBMIT_ANALYSIS_TOOL_NAME,
            input: verdictPayload,
          } as unknown as Anthropic.Messages.ContentBlock,
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 40 },
      },
    ]);
    _setClientFactoryForTests(() => client as unknown as Anthropic);
    try {
      const r = await runUploadAnalysis({
        sampleId,
        customer: "RunAnalysisTest",
        weekStart,
        fileName,
        lane: "parser",
      });
      assert.equal(r.ok, true);
      assert.equal(r.verdict, "warn");
      assert.ok(typeof r.verdictId === "number");
      const rows = await db
        .select()
        .from(schema.uploadAnalysisVerdictsTable)
        .where(eq(schema.uploadAnalysisVerdictsTable.sampleId, sampleId));
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.verdict, "warn");
      assert.equal(row.lane, "parser");
      assert.equal(row.promptVersion, PROMPT_VERSION);
      assert.ok(Array.isArray(row.findings));
      assert.equal((row.findings as unknown[]).length, 1);
      assert.equal(row.errMsg, null);
      assert.ok(row.costUsd >= 0);
    } finally {
      _resetClientFactoryForTests();
      await cleanup(sampleId);
    }
  });

  test("runUploadAnalysis persists an error row when payload fails validation", async () => {
    const { sampleId, weekStart, fileName } = await seedSample(
      `RunAnalysisBad_${Date.now()}`,
    );
    const client = makeClient([
      {
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: SUBMIT_ANALYSIS_TOOL_NAME,
            input: { verdict: "not-a-real-verdict" },
          } as unknown as Anthropic.Messages.ContentBlock,
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);
    _setClientFactoryForTests(() => client as unknown as Anthropic);
    try {
      const r = await runUploadAnalysis({
        sampleId,
        customer: "RunAnalysisBad",
        weekStart,
        fileName,
        lane: "ai",
      });
      assert.equal(r.ok, false);
      assert.ok(r.validationError);
      const rows = await db
        .select()
        .from(schema.uploadAnalysisVerdictsTable)
        .where(eq(schema.uploadAnalysisVerdictsTable.sampleId, sampleId));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.verdict, "error");
      assert.ok(rows[0]!.errMsg && rows[0]!.errMsg.includes("validation"));
    } finally {
      _resetClientFactoryForTests();
      await cleanup(sampleId);
    }
  });

  test("out-of-order completion: older sample's late verdict never wins over newer sample's verdict", async () => {
    const customer = `OutOfOrder_${Date.now()}`;
    const weekStart = "2026-01-04";
    await db
      .insert(schema.weeksTable)
      .values({ startDate: weekStart, endDate: "2026-01-10" })
      .onConflictDoNothing();
    async function seed(fileName: string, confirmedAt: Date): Promise<number> {
      const ins = await db
        .insert(schema.aiExtractSamplesTable)
        .values({
          weekStart,
          customer,
          fileName,
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          sizeBytes: 4,
          fileBytes: Buffer.from("test"),
          extractedRows: [],
          pendingNamedRows: null,
          droppedRows: [],
          confirmedAt,
          expiresAt: new Date(Date.now() + 60_000),
        })
        .returning({ id: schema.aiExtractSamplesTable.id });
      return ins[0]!.id;
    }
    const olderConfirmedAt = new Date(Date.now() - 60_000);
    const newerConfirmedAt = new Date();
    const olderSampleId = await seed("older.xlsx", olderConfirmedAt);
    const newerSampleId = await seed("newer.xlsx", newerConfirmedAt);
    try {
      function scriptClient(verdict: string) {
        return makeClient([
          {
            content: [
              {
                type: "tool_use",
                id: "tu_1",
                name: SUBMIT_ANALYSIS_TOOL_NAME,
                input: {
                  verdict,
                  lane: "parser",
                  summary: `verdict-${verdict}`,
                  findings: [],
                },
              } as unknown as Anthropic.Messages.ContentBlock,
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        ]);
      }
      // Simulate the *newer* upload's analysis finishing first.
      _setClientFactoryForTests(
        () => scriptClient("ok") as unknown as Anthropic,
      );
      await runUploadAnalysis({
        sampleId: newerSampleId,
        customer,
        weekStart,
        fileName: "newer.xlsx",
        lane: "parser",
      });
      // Now the *older* upload's analysis finally lands — created_at is
      // later than the newer one's. The dashboard query must still surface
      // the newer sample's verdict, because it anchors on latest confirmed
      // sample, not latest verdict row.
      _setClientFactoryForTests(
        () => scriptClient("fail") as unknown as Anthropic,
      );
      await runUploadAnalysis({
        sampleId: olderSampleId,
        customer,
        weekStart,
        fileName: "older.xlsx",
        lane: "parser",
      });

      const rows: Array<{ sampleId: number; verdict: string }> = await db
        .execute(sql`
          WITH latest_sample AS (
            SELECT DISTINCT ON (lower(customer)) id, customer
            FROM ai_extract_samples
            WHERE week_start = ${weekStart}
              AND lower(customer) = lower(${customer})
              AND confirmed_at IS NOT NULL
            ORDER BY lower(customer), confirmed_at DESC, id DESC
          )
          SELECT v.sample_id AS "sampleId", v.verdict AS verdict
          FROM latest_sample ls
          JOIN upload_analysis_verdicts v ON v.sample_id = ls.id
        `)
        .then(
          (r: { rows: unknown[] }) =>
            r.rows as Array<{ sampleId: number; verdict: string }>,
        );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.sampleId, newerSampleId);
      assert.equal(rows[0]!.verdict, "ok");
    } finally {
      _resetClientFactoryForTests();
      await cleanup(olderSampleId);
      await cleanup(newerSampleId);
    }
  });

  test("re-running analysis on the same sample upserts the existing row", async () => {
    const { sampleId, weekStart, fileName } = await seedSample(
      `Upsert_${Date.now()}`,
    );
    function scriptClient(verdict: string) {
      return makeClient([
        {
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: SUBMIT_ANALYSIS_TOOL_NAME,
              input: {
                verdict,
                lane: "parser",
                summary: `run-${verdict}`,
                findings: [],
              },
            } as unknown as Anthropic.Messages.ContentBlock,
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ]);
    }
    try {
      _setClientFactoryForTests(
        () => scriptClient("warn") as unknown as Anthropic,
      );
      const r1 = await runUploadAnalysis({
        sampleId,
        customer: "Upsert",
        weekStart,
        fileName,
        lane: "parser",
      });
      _setClientFactoryForTests(
        () => scriptClient("ok") as unknown as Anthropic,
      );
      const r2 = await runUploadAnalysis({
        sampleId,
        customer: "Upsert",
        weekStart,
        fileName,
        lane: "parser",
      });
      assert.equal(r1.ok, true);
      assert.equal(r2.ok, true);
      const rows = await db
        .select()
        .from(schema.uploadAnalysisVerdictsTable)
        .where(eq(schema.uploadAnalysisVerdictsTable.sampleId, sampleId));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.verdict, "ok");
      assert.equal(rows[0]!.summary, "run-ok");
    } finally {
      _resetClientFactoryForTests();
      await cleanup(sampleId);
    }
  });

  test("scheduleUploadAnalysis is env-gated and does nothing when disabled", async () => {
    const { scheduleUploadAnalysis } = await import("../runAnalysis.js");
    const prev = process.env.UPLOAD_ANALYSIS_ENABLED;
    delete process.env.UPLOAD_ANALYSIS_ENABLED;
    let called = false;
    _setClientFactoryForTests(() => {
      called = true;
      throw new Error("should not be called when flag is off");
    });
    try {
      scheduleUploadAnalysis({
        sampleId: -1,
        customer: "Nope",
        weekStart: "2026-01-04",
        fileName: "x.xlsx",
        lane: "parser",
      });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(called, false);
    } finally {
      if (prev !== undefined) process.env.UPLOAD_ANALYSIS_ENABLED = prev;
      _resetClientFactoryForTests();
    }
  });
}
