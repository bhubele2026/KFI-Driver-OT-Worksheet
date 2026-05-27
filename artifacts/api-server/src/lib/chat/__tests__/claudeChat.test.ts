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

function makeCtx(
  cache: InstanceType<typeof _internals.ChatToolCache> = new _internals.ChatToolCache(),
) {
  return {
    weekStart: "2026-01-04",
    customer: "Acme",
    cache,
    evidence: new _internals.EvidenceAccumulator(),
  };
}

function call(name: string, input: Record<string, unknown>) {
  return _internals.runTool(
    {
      type: "tool_use",
      id: "tu_test",
      name,
      input,
    } as unknown as Parameters<typeof _internals.runTool>[0],
    makeCtx(),
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
    makeCtx(cache),
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
    droppedRows: null,
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

function makeLookupData(): import("../claudeChat.js").LookupDriverData {
  return {
    drivers: [
      { kfiId: "100", name: "Alice Smith" },
      { kfiId: "101", name: "Bob Jones" },
      { kfiId: "102", name: "Carol Smith" },
      { kfiId: "103", name: "Dan Smith" },
      { kfiId: "104", name: "Erin Smithfield" },
      { kfiId: "105", name: "Frank Smithers" },
      { kfiId: "106", name: "Gail Brown" },
    ],
    customerAliases: [
      { kfiId: "106", nameOnDoc: "G. Brown" },
      { kfiId: "106", nameOnDoc: "Smithy" },
    ],
    idAliases: [
      { kfiId: "101", externalId: "BJ-42" },
      { kfiId: "100", externalId: "A-100" },
    ],
  };
}

test("lookup_driver: substring on driver name returns the right driver", async () => {
  _internals.setLookupDriverDataOverride(() => makeLookupData());
  try {
    const r = await call("lookup_driver", { nameOrBadge: "alice" });
    const body = JSON.parse(r.resultText);
    assert.equal(body.matches.length, 1);
    assert.equal(body.matches[0].kfiId, "100");
    assert.equal(body.matches[0].name, "Alice Smith");
    assert.deepEqual(body.matches[0].badges, ["A-100"]);
    assert.deepEqual(body.matches[0].aliasesForCustomer, []);
  } finally {
    _internals.setLookupDriverDataOverride(null);
  }
});

test("lookup_driver: exact badge match returns the right driver first", async () => {
  _internals.setLookupDriverDataOverride(() => makeLookupData());
  try {
    const r = await call("lookup_driver", { nameOrBadge: "bj-42" });
    const body = JSON.parse(r.resultText);
    assert.ok(body.matches.length >= 1);
    assert.equal(body.matches[0].kfiId, "101");
    assert.equal(body.matches[0].name, "Bob Jones");
    assert.deepEqual(body.matches[0].badges, ["BJ-42"]);
  } finally {
    _internals.setLookupDriverDataOverride(null);
  }
});

test("lookup_driver: customer-scoped alias substring resolves to the aliased driver", async () => {
  _internals.setLookupDriverDataOverride(() => makeLookupData());
  try {
    // "Smithy" is an alias for Gail Brown (kfi 106) under the scoped
    // customer — it must resolve to 106, not to any of the literal
    // "Smith" drivers.
    const r = await call("lookup_driver", { nameOrBadge: "smithy" });
    const body = JSON.parse(r.resultText);
    const hit = body.matches.find((m: { kfiId: string }) => m.kfiId === "106");
    assert.ok(hit, "expected Gail Brown via alias 'Smithy'");
    assert.deepEqual(hit.aliasesForCustomer, ["G. Brown", "Smithy"]);
  } finally {
    _internals.setLookupDriverDataOverride(null);
  }
});

test("lookup_driver: no match returns an empty matches array (not an error)", async () => {
  _internals.setLookupDriverDataOverride(() => makeLookupData());
  try {
    const r = await call("lookup_driver", { nameOrBadge: "zzzzzz" });
    assert.equal(r.isError, undefined);
    const body = JSON.parse(r.resultText);
    assert.deepEqual(body, { matches: [] });
  } finally {
    _internals.setLookupDriverDataOverride(null);
  }
});

test("lookup_driver: caps results at 5", async () => {
  _internals.setLookupDriverDataOverride(() => makeLookupData());
  try {
    // "smith" appears in 5 driver names AND in the "Smithy" alias for
    // kfi 106 — six total candidates; the cap must hold the response
    // at five.
    const r = await call("lookup_driver", { nameOrBadge: "smith" });
    const body = JSON.parse(r.resultText);
    assert.equal(body.matches.length, _internals.LOOKUP_DRIVER_MAX_RESULTS);
    assert.equal(body.matches.length, 5);
  } finally {
    _internals.setLookupDriverDataOverride(null);
  }
});

test("lookup_driver: missing nameOrBadge returns an error", async () => {
  const r = await call("lookup_driver", { nameOrBadge: "   " });
  assert.equal(r.isError, true);
});

test("unknown tool name returns an error result", async () => {
  const r = await call("propose_buy_lunch", { lessonText: "x" });
  assert.equal(r.isError, true);
});

test("read_upload_file_rows: no stashed sample → returns a clear message", async () => {
  const r = await callWithSample("read_upload_file_rows", {}, null);
  const body = JSON.parse(r.resultText);
  assert.equal(body.lastUpload, null);
  assert.match(body.message, /No source file is recoverable/);
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

test("read_upload_file_rows: records de-duplicated evidence rows for the turn", async () => {
  // Task #420: every successful row-read records the returned rows
  // on the per-turn evidence accumulator so the dispatcher can see
  // exactly what the assistant looked at. Repeated calls within the
  // same turn de-dupe by (kfiId, date, in, out) for resolved rows.
  const cache = new _internals.ChatToolCache();
  cache.preloadSample(makeSample());
  const ctx = makeCtx(cache);
  await _internals.runTool(
    {
      type: "tool_use",
      id: "tu_ev_1",
      name: "read_upload_file_rows",
      input: { date: "2026-01-06" },
    } as unknown as Parameters<typeof _internals.runTool>[0],
    ctx,
  );
  await _internals.runTool(
    {
      type: "tool_use",
      id: "tu_ev_2",
      name: "read_upload_file_rows",
      input: { date: "2026-01-07" },
    } as unknown as Parameters<typeof _internals.runTool>[0],
    ctx,
  );
  // Second filter for the same date — should NOT duplicate.
  await _internals.runTool(
    {
      type: "tool_use",
      id: "tu_ev_3",
      name: "read_upload_file_rows",
      input: { date: "2026-01-06" },
    } as unknown as Parameters<typeof _internals.runTool>[0],
    ctx,
  );
  // Empty filter — picks up the pending row too.
  await _internals.runTool(
    {
      type: "tool_use",
      id: "tu_ev_4",
      name: "read_upload_file_rows",
      input: {},
    } as unknown as Parameters<typeof _internals.runTool>[0],
    ctx,
  );
  const built = ctx.evidence.build();
  assert.ok(built, "expected evidence to be populated");
  assert.equal(built!.sampleId, 1);
  assert.equal(built!.fileName, "acme.xlsx");
  assert.equal(built!.resolvedRows.length, 2, "de-duped to two unique resolved rows");
  assert.equal(built!.pendingRows.length, 1);
  assert.equal(built!.resolvedRows[0].kfiId, "100");
  assert.equal(built!.pendingRows[0].driverNameOnDoc, "Willie Medina");
});

test("evidence accumulator stays null when no rows are returned", async () => {
  // Task #420: a turn that never calls read_upload_file_rows (or
  // calls it without a stashed sample) should not surface an empty
  // "Evidence from file" card.
  const ev = new _internals.EvidenceAccumulator();
  assert.equal(ev.build(), null);
  const cache = new _internals.ChatToolCache();
  cache.preloadSample(null);
  const ctx = makeCtx(cache);
  await _internals.runTool(
    {
      type: "tool_use",
      id: "tu_no_sample",
      name: "read_upload_file_rows",
      input: {},
    } as unknown as Parameters<typeof _internals.runTool>[0],
    ctx,
  );
  assert.equal(ctx.evidence.build(), null);
});

test("read_upload_file_rows: surfaces droppedRows with typed reasons (Task #427)", async () => {
  const sample = makeSample({
    droppedRows: [
      {
        reason: "no_driver_match",
        detail: "name 'Bob Q.' not in roster and no alias hit",
        rawRow: {
          driverNameOnDoc: "Bob Q.",
          badgeOrId: null,
          date: "2026-01-06",
          timeIn: "7:00 AM",
          timeOut: "3:00 PM",
          hours: 8,
        },
      },
      {
        reason: "outside_week",
        detail: "date 2026-02-01 outside 2026-01-04..2026-01-10",
        rawRow: {
          driverNameOnDoc: "Smith",
          badgeOrId: null,
          date: "2026-02-01",
          timeIn: null,
          timeOut: null,
          hours: null,
        },
      },
    ],
  });
  // Unfiltered: both dropped rows are returned.
  const all = await callWithSample("read_upload_file_rows", {}, sample);
  const allBody = JSON.parse(all.resultText);
  assert.equal(allBody.droppedRowsTotal, 2);
  assert.equal(allBody.droppedRowsReturned, 2);
  assert.equal(allBody.droppedRows[0].reason, "no_driver_match");
  assert.ok(allBody.droppedRows[0].rawRow.timeIn === "7:00 AM");

  // Filter by date: only the matching dropped row comes back, but the
  // total still reflects the underlying stash.
  const filtered = await callWithSample(
    "read_upload_file_rows",
    { date: "2026-01-06" },
    sample,
  );
  const fBody = JSON.parse(filtered.resultText);
  assert.equal(fBody.droppedRowsTotal, 2);
  assert.equal(fBody.droppedRowsReturned, 1);
  assert.equal(fBody.droppedRows[0].rawRow.driverNameOnDoc, "Bob Q.");

  // Filter by driverNameContains is case-insensitive on driverNameOnDoc.
  const byName = await callWithSample(
    "read_upload_file_rows",
    { driverNameContains: "smith" },
    sample,
  );
  const nBody = JSON.parse(byName.resultText);
  assert.equal(nBody.droppedRowsReturned, 1);
  assert.equal(nBody.droppedRows[0].reason, "outside_week");
});

test("evidence accumulator dedupes dropped rows across repeated reads (Task #427)", async () => {
  const sample = makeSample({
    droppedRows: [
      {
        reason: "no_driver_match",
        detail: "name 'Bob Q.' not in roster",
        rawRow: {
          driverNameOnDoc: "Bob Q.",
          badgeOrId: null,
          date: "2026-01-06",
          timeIn: "7:00 AM",
          timeOut: "3:00 PM",
          hours: 8,
        },
      },
    ],
  });
  const cache = new _internals.ChatToolCache();
  cache.preloadSample(sample);
  const ctx = makeCtx(cache);
  for (let i = 0; i < 3; i++) {
    await _internals.runTool(
      {
        type: "tool_use",
        id: `tu_drop_${i}`,
        name: "read_upload_file_rows",
        input: { date: "2026-01-06" },
      } as unknown as Parameters<typeof _internals.runTool>[0],
      ctx,
    );
  }
  const built = ctx.evidence.build();
  assert.ok(built, "evidence accumulator should have content");
  assert.ok(built!.droppedRows, "droppedRows should be surfaced");
  assert.equal(built!.droppedRows!.length, 1, "duplicate drops collapse to one");
  assert.equal(built!.droppedRows![0].reason, "no_driver_match");
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

test("read_upload_file_raw: image uploads route through the OCR fallback (Task #421)", async () => {
  // Stub the OCR seam so the test doesn't need a model client / API
  // key. The chat path should call this with the image sample and
  // return its transcription as if it were any other raw read.
  const ocrCalls: string[] = [];
  _internals.setOcrOverride(async (s) => {
    ocrCalls.push(`${s.fileName}|${s.mimeType}`);
    return "Driver Date In Out\nSmith 2026-01-06 7:00 15:30";
  });
  try {
    const sample = makeSample({
      fileName: "scan.jpg",
      mimeType: "image/jpeg",
      fileBytes: Buffer.from([0xff, 0xd8, 0xff]),
    });
    const r = await callWithSample("read_upload_file_raw", { maxBytes: 1000 }, sample);
    const body = JSON.parse(r.resultText);
    assert.equal(body.sampleId, sample.id);
    assert.equal(body.mimeType, "image/jpeg");
    assert.match(body.text, /Smith 2026-01-06 7:00 15:30/);
    assert.equal(body.truncated, false);
    assert.deepEqual(ocrCalls, ["scan.jpg|image/jpeg"]);
  } finally {
    _internals.setOcrOverride(null);
  }
});

test("read_upload_file_raw: records de-duplicated raw-snippet evidence (Task #424)", async () => {
  // Build a small xlsx so two raw reads return the same prefix. The
  // accumulator should collapse them into a single rawSnippets entry
  // with the file name, total/returned char counts, and the first
  // ~500 chars of what Claude actually saw.
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["Driver", "Date", "In", "Out"],
    ["Smith", "2026-01-06", "7:00", "15:30"],
    ["Jones", "2026-01-07", "8:00", "16:30"],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const sample = makeSample({ fileBytes: buf });
  const cache = new _internals.ChatToolCache();
  cache.preloadSample(sample);
  const ctx = makeCtx(cache);

  for (const id of ["raw_1", "raw_2"]) {
    await _internals.runTool(
      {
        type: "tool_use",
        id,
        name: "read_upload_file_raw",
        input: { maxBytes: 1000 },
      } as unknown as Parameters<typeof _internals.runTool>[0],
      ctx,
    );
  }
  const built = ctx.evidence.build();
  assert.ok(built, "expected evidence to be populated by raw read");
  assert.equal(built!.sampleId, sample.id);
  assert.equal(built!.fileName, sample.fileName);
  assert.equal(built!.resolvedRows.length, 0);
  assert.equal(built!.pendingRows.length, 0);
  assert.ok(built!.rawSnippets, "expected rawSnippets array");
  assert.equal(
    built!.rawSnippets!.length,
    1,
    "two reads with identical prefix collapse to one entry",
  );
  const snip = built!.rawSnippets![0];
  assert.equal(snip.sampleId, sample.id);
  assert.equal(snip.fileName, sample.fileName);
  assert.ok(snip.totalChars > 0);
  assert.ok(snip.returnedChars > 0);
  assert.ok(snip.snippet.length <= 500);
  assert.match(snip.snippet, /Smith/);
});

test("read_upload_file_raw: no rawSnippet evidence when sample is missing (Task #424)", async () => {
  const cache = new _internals.ChatToolCache();
  cache.preloadSample(null);
  const ctx = makeCtx(cache);
  await _internals.runTool(
    {
      type: "tool_use",
      id: "raw_no_sample",
      name: "read_upload_file_raw",
      input: {},
    } as unknown as Parameters<typeof _internals.runTool>[0],
    ctx,
  );
  assert.equal(ctx.evidence.build(), null);
});

test("read_upload_file_raw: rejects unsupported file types with a clear error", async () => {
  const sample = makeSample({
    fileName: "notes.txt",
    mimeType: "text/plain",
    fileBytes: Buffer.from("hello"),
  });
  const r = await callWithSample("read_upload_file_raw", {}, sample);
  const body = JSON.parse(r.resultText);
  // No throw — returns a clean explanatory message so Claude can
  // pivot to asking the dispatcher.
  assert.equal(body.text, null);
  assert.match(body.message, /unsupported/i);
});

test("read budget caps total reads per turn", async () => {
  const cache = new _internals.ChatToolCache();
  cache.preloadSample(makeSample());
  const ctx = makeCtx(cache);
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
  const ctx = makeCtx(cache);
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

test("buildSystemPrompt: no customer-service preambles (Task #426)", async () => {
  const prompt = await _internals.buildSystemPrompt("2026-01-04", "Burnett");
  // The body of the prompt — i.e., the text outside the BAD example
  // and the explicit banned-phrasings enumeration — must never
  // instruct or model the banned phrasings as something to do. Strip:
  //   - lines beginning with the markdown quote marker (">") — the
  //     BAD example block,
  //   - lines beginning with `- "` — the banned-openings bullet list.
  const nonExampleBody = prompt
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith(">") && !t.startsWith('- "');
    })
    .join("\n");
  assert.doesNotMatch(
    nonExampleBody,
    /I'?ll help|Let me help|Let me look|Let me check|I'?d be happy|happy to help/i,
    "system prompt body must not contain customer-service phrasings",
  );
  // The BAD/GOOD example pair must be present so the model has a
  // pattern to match against.
  assert.match(prompt, /BAD/);
  assert.match(prompt, /GOOD/);
  // Investigation-first rule must be the first major section.
  const investigationIdx = prompt.indexOf("Investigation first");
  const outputRulesIdx = prompt.indexOf("Output rules");
  assert.ok(investigationIdx > 0, "expected an 'Investigation first' section");
  assert.ok(
    investigationIdx < outputRulesIdx,
    "investigation rules must come before output rules",
  );
});

test("runChatTurn: assistant text does not start with a customer-service preamble (Task #426)", async () => {
  // Drive the tool loop with a stubbed Anthropic client that returns a
  // single end_turn text block — exactly what we want the model to do
  // when it has finished its investigation. The test asserts the
  // returned `assistantText` is passed through verbatim (no wrapper
  // code prepends "I'll help…" / "Let me…") and matches the terse
  // voice the new prompt demands.
  const stubReply =
    "Burnett file for 2026-01-04 has one Willie Medina row on the 23rd: 6:00 AM – 2:30 PM, 8.5 hrs.";
  const stub = {
    messages: {
      create: async () => ({
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: "stub",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "text", text: stubReply }],
      }),
    },
  };
  _internals.setClaudeClientOverride(stub as unknown as Parameters<typeof _internals.setClaudeClientOverride>[0]);
  try {
    const { runChatTurn } = await import("../claudeChat.js");
    const result = await runChatTurn({
      weekStart: "2026-01-04",
      customer: "Burnett",
      history: [],
      userMessage: "Burnett's file missed Willie Medina on the 23rd",
    });
    const trimmed = result.assistantText.trim();
    assert.equal(trimmed, stubReply, "assistantText is passed through unchanged");
    assert.doesNotMatch(
      trimmed,
      /^(I'?ll\b|Let me\b|I'?d be happy|happy to help|Sure[!,]|Of course|Got it)/i,
      "assistantText must not start with a customer-service preamble",
    );
  } finally {
    _internals.setClaudeClientOverride(null);
  }
});

test("no-sample read still counts against the call budget", async () => {
  const cache = new _internals.ChatToolCache();
  cache.preloadSample(null);
  const ctx = makeCtx(cache);
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
