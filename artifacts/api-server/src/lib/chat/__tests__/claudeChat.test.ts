import test from "node:test";
import assert from "node:assert/strict";
import { _internals, type UploadSampleCache } from "../claudeChat.js";

/**
 * Task #406 (T007): deterministic coverage for the Claude chat tool
 * layer's propose-* tools. The read tools touch the DB so they're
 * covered by the apply-flow e2e spec; here we lock in the structured
 * payload shape every propose tool emits so the apply route never sees
 * a malformed `proposedFix`.
 *
 * We invoke `runTool` directly with a synthetic Anthropic
 * `ToolUseBlock` — no API key, no SDK calls.
 */

function call(name: string, input: Record<string, unknown>) {
  return _internals.runTool(
    {
      type: "tool_use",
      id: "tu_test",
      name,
      input,
    } as unknown as Parameters<typeof _internals.runTool>[0],
    {
      weekStart: "2026-01-04",
      customer: "Acme",
      cache: new _internals.ChatToolCache(),
    },
  );
}

function callWithSample(
  name: string,
  input: Record<string, unknown>,
  sample: UploadSampleCache | null,
) {
  const cache = new _internals.ChatToolCache();
  cache.preloadSample(sample);
  return _internals.runTool(
    {
      type: "tool_use",
      id: "tu_test",
      name,
      input,
    } as unknown as Parameters<typeof _internals.runTool>[0],
    { weekStart: "2026-01-04", customer: "Acme", cache },
  );
}

function makeSample(
  overrides: Partial<UploadSampleCache> = {},
): UploadSampleCache {
  return {
    id: 1,
    fileName: "acme.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sizeBytes: 1234,
    uploadedAt: new Date("2026-01-05T12:00:00Z"),
    fileBytes: Buffer.from(""),
    extractedRows: [
      {
        kfiId: "100",
        customer: "Acme",
        date: "2026-01-06",
        clockIn: "7:00 AM",
        clockOut: "3:30 PM",
        hours: 8.5,
        payType: "Reg",
      },
      {
        kfiId: "101",
        customer: "Acme",
        date: "2026-01-07",
        clockIn: "8:00 AM",
        clockOut: "5:00 PM",
        hours: 9,
        payType: "Reg",
      },
    ],
    pendingNamedRows: [
      {
        driverNameOnDoc: "Willie Medina",
        badgeOrId: "W99",
        date: "2026-01-08",
        timeIn: "6:00 AM",
        timeOut: "2:30 PM",
        hours: 8.5,
      },
    ],
    ...overrides,
  };
}

test("propose_add_punches: requires lessonText + ≥1 punch", async () => {
  const empty = await call("propose_add_punches", {
    punches: [],
    lessonText: "x",
  });
  assert.equal(empty.isError, true);
  const noLesson = await call("propose_add_punches", {
    punches: [{ kfiId: "100", date: "2026-01-05", clockIn: "7:00 AM", clockOut: "3:00 PM" }],
    lessonText: "",
  });
  assert.equal(noLesson.isError, true);
});

test("propose_add_punches: normalizes payload + carries lesson", async () => {
  const r = await call("propose_add_punches", {
    punches: [
      {
        kfiId: "100",
        date: "2026-01-05",
        clockIn: "7:00 AM",
        clockOut: "3:00 PM",
        payType: "Reg",
        notes: "first run",
      },
    ],
    lessonText: "Acme always shows Reg, never blank.",
  });
  assert.ok(r.proposal, "expected a proposal");
  assert.equal(r.proposal!.fix.kind, "addPunches");
  assert.equal(r.proposal!.lesson, "Acme always shows Reg, never blank.");
  assert.deepEqual(
    (r.proposal!.fix as { punches: unknown[] }).punches[0],
    {
      kfiId: "100",
      date: "2026-01-05",
      clockIn: "7:00 AM",
      clockOut: "3:00 PM",
      payType: "Reg",
      notes: "first run",
    },
  );
});

test("propose_edit_punch: only carries fields the dispatcher set", async () => {
  const r = await call("propose_edit_punch", {
    punchId: 42,
    hours: 8.25,
    lessonText: "Acme's 7:30 punch is actually 7:15.",
  });
  assert.ok(r.proposal);
  const fix = r.proposal!.fix as {
    kind: string;
    punchId: number;
    hours?: number;
    clockIn?: string;
  };
  assert.equal(fix.kind, "editPunch");
  assert.equal(fix.punchId, 42);
  assert.equal(fix.hours, 8.25);
  assert.equal(fix.clockIn, undefined);
});

test("propose_edit_punch: rejects non-integer punchId", async () => {
  const r = await call("propose_edit_punch", {
    punchId: "forty-two",
    lessonText: "x",
  });
  assert.equal(r.isError, true);
});

test("propose_delete_punch: requires punchId + reason + lesson", async () => {
  const r = await call("propose_delete_punch", {
    punchId: 7,
    reason: "Duplicate",
    lessonText: "Acme files duplicate the lunch break.",
  });
  assert.ok(r.proposal);
  const fix = r.proposal!.fix as { kind: string; reason: string };
  assert.equal(fix.kind, "deletePunch");
  assert.equal(fix.reason, "Duplicate");

  const bad = await call("propose_delete_punch", { punchId: 7, reason: "", lessonText: "x" });
  assert.equal(bad.isError, true);
});

test("propose_add_driver_alias: trims inputs and produces alias fix", async () => {
  const r = await call("propose_add_driver_alias", {
    nameOnDoc: "  J. Smith ",
    kfiId: "100",
    lessonText: "Acme uses initials.",
  });
  assert.ok(r.proposal);
  const fix = r.proposal!.fix as {
    kind: string;
    nameOnDoc: string;
    kfiId: string;
  };
  assert.equal(fix.kind, "addDriverAlias");
  assert.equal(fix.nameOnDoc, "J. Smith");
  assert.equal(fix.kfiId, "100");
});

test("propose_re_extract_with_hint: hint+lesson required, sampleId optional", async () => {
  const r = await call("propose_re_extract_with_hint", {
    hint: "Date column is at index 3, not 2.",
    sampleId: 999,
    lessonText: "Acme's date column moved.",
  });
  assert.ok(r.proposal);
  const fix = r.proposal!.fix as { kind: string; hint: string; sampleId?: number };
  assert.equal(fix.kind, "reExtractWithHint");
  assert.equal(fix.sampleId, 999);

  const bad = await call("propose_re_extract_with_hint", { hint: "", lessonText: "x" });
  assert.equal(bad.isError, true);
});

test("unknown tool name returns an error result", async () => {
  const r = await call("propose_buy_lunch", { lessonText: "x" });
  assert.equal(r.isError, true);
});

test("read_upload_file_rows: no stashed sample → returns a clear message", async () => {
  const r = await callWithSample("read_upload_file_rows", {}, null);
  const body = JSON.parse(r.resultText);
  assert.equal(body.lastUpload, null);
  assert.match(body.message, /No AI-extracted sample/);
});

test("read_upload_file_rows: returns resolved + pending rows from stash", async () => {
  const r = await callWithSample("read_upload_file_rows", {}, makeSample());
  const body = JSON.parse(r.resultText);
  assert.equal(body.resolvedRowsTotal, 2);
  assert.equal(body.pendingRowsTotal, 1);
  assert.equal(body.resolvedRowsReturned, 2);
  assert.equal(body.pendingRowsReturned, 1);
  // Each resolved row carries the times the AI extractor saw.
  assert.equal(body.resolvedRows[0].kfiId, "100");
  assert.equal(body.resolvedRows[0].clockIn, "7:00 AM");
  assert.equal(body.resolvedRows[0].clockOut, "3:30 PM");
  // Pending rows carry the doc-side info, including doc-name + times.
  assert.equal(body.pendingRows[0].driverNameOnDoc, "Willie Medina");
  assert.equal(body.pendingRows[0].timeIn, "6:00 AM");
});

test("read_upload_file_rows: date + kfiId filters narrow the response", async () => {
  const r = await callWithSample(
    "read_upload_file_rows",
    { date: "2026-01-07", kfiId: "101" },
    makeSample(),
  );
  const body = JSON.parse(r.resultText);
  assert.equal(body.resolvedRowsReturned, 1);
  assert.equal(body.resolvedRows[0].kfiId, "101");
  assert.equal(body.pendingRowsReturned, 0);
});

test("read_upload_file_raw: returns CSV-serialized xlsx text within byte cap", async () => {
  // Build a tiny one-sheet xlsx in memory so the raw path actually
  // round-trips through `XLSX.read` + `sheet_to_csv` without a DB.
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["Driver", "Date", "In", "Out"],
    ["Smith", "2026-01-06", "7:00", "15:30"],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const sample = makeSample({ fileBytes: buf });

  const r = await callWithSample("read_upload_file_raw", { maxBytes: 1000 }, sample);
  const body = JSON.parse(r.resultText);
  assert.equal(body.sampleId, sample.id);
  assert.match(body.text, /# Sheet: Sheet1/);
  assert.match(body.text, /Smith.*2026-01-06.*7:00.*15:30/);
});

test("read_upload_file_raw: rejects unsupported file types with a clear error", async () => {
  const sample = makeSample({
    fileName: "scan.jpg",
    mimeType: "image/jpeg",
    fileBytes: Buffer.from([0xff, 0xd8, 0xff]),
  });
  const r = await callWithSample("read_upload_file_raw", {}, sample);
  const body = JSON.parse(r.resultText);
  // No throw — returns a clean explanatory message so Claude can
  // pivot to asking the dispatcher.
  assert.equal(body.text, null);
  assert.match(body.message, /scanned image|unsupported|extractable/i);
});

test("read budget caps total reads per turn", async () => {
  const cache = new _internals.ChatToolCache();
  cache.preloadSample(makeSample());
  const ctx = { weekStart: "2026-01-04", customer: "Acme", cache };
  let lastErr: { isError?: boolean; resultText: string } | null = null;
  for (let i = 0; i < _internals.CHAT_FILE_READ_MAX_CALLS + 2; i++) {
    lastErr = await _internals.runTool(
      {
        type: "tool_use",
        id: `tu_${i}`,
        name: "read_upload_file_rows",
        input: {},
      } as unknown as Parameters<typeof _internals.runTool>[0],
      ctx,
    );
  }
  assert.equal(lastErr?.isError, true);
  assert.match(lastErr!.resultText, /budget exhausted/);
});

test("over-budget raw read does NOT invoke the parser (DoS guard)", async () => {
  const cache = new _internals.ChatToolCache();
  // Sentinel sample: any attempt to access fileBytes via getRawText
  // would re-parse and throw. We pre-resolve rawTextPromise with a
  // booby-trapped getter so a leak shows up as a test failure.
  cache.preloadSample(makeSample());
  let parserInvoked = false;
  // Monkey-patch getRawText to flip the sentinel if it's ever called.
  const orig = cache.getRawText.bind(cache);
  cache.getRawText = async (ctx) => {
    parserInvoked = true;
    return orig(ctx);
  };
  const ctx = { weekStart: "2026-01-04", customer: "Acme", cache };
  // Exhaust the call budget with cheap row reads first.
  for (let i = 0; i < _internals.CHAT_FILE_READ_MAX_CALLS; i++) {
    await _internals.runTool(
      {
        type: "tool_use",
        id: `tu_burn_${i}`,
        name: "read_upload_file_rows",
        input: {},
      } as unknown as Parameters<typeof _internals.runTool>[0],
      ctx,
    );
  }
  // Now ask for a raw read — should short-circuit at the budget gate
  // BEFORE getRawText (parsing) is invoked.
  const r = await _internals.runTool(
    {
      type: "tool_use",
      id: "tu_raw_over",
      name: "read_upload_file_raw",
      input: {},
    } as unknown as Parameters<typeof _internals.runTool>[0],
    ctx,
  );
  assert.equal(r.isError, true);
  assert.match(r.resultText, /budget exhausted/);
  assert.equal(parserInvoked, false, "parser must not be invoked once the call budget is blown");
});

test("no-sample read still counts against the call budget", async () => {
  const cache = new _internals.ChatToolCache();
  cache.preloadSample(null);
  const ctx = { weekStart: "2026-01-04", customer: "Acme", cache };
  for (let i = 0; i < _internals.CHAT_FILE_READ_MAX_CALLS; i++) {
    const r = await _internals.runTool(
      {
        type: "tool_use",
        id: `tu_none_${i}`,
        name: "read_upload_file_rows",
        input: {},
      } as unknown as Parameters<typeof _internals.runTool>[0],
      ctx,
    );
    // Each no-sample read returns ok (not isError) but still
    // consumes a call slot.
    assert.notEqual(r.isError, true);
  }
  const over = await _internals.runTool(
    {
      type: "tool_use",
      id: "tu_none_over",
      name: "read_upload_file_rows",
      input: {},
    } as unknown as Parameters<typeof _internals.runTool>[0],
    ctx,
  );
  assert.equal(over.isError, true);
  assert.match(over.resultText, /budget exhausted/);
});
