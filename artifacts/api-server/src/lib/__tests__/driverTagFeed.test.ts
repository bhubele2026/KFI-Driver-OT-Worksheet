import test from "node:test";
import assert from "node:assert/strict";
import { buildDriverTagFeed } from "../driverTagFeed.js";

const driver = (
  kfiId: string,
  name: string,
  tagNumber: string | null,
  tagNumberUpdatedAt: Date | null = null,
) => ({ kfiId, name, tagNumber, tagNumberUpdatedAt });

test("an untagged driver is ABSENT, never present with a null tag", () => {
  // ⚠️ THE CLEARING CONTRACT. The consumer replaces the table from this array,
  // so absence is the only signal that a tag was cleared. A null-tag row here
  // would make a cleared tag survive in the warehouse forever.
  const feed = buildDriverTagFeed(
    [driver("2004863", "Jose Angulo Alfaro", "10020908"), driver("2005001", "Nobody Tagged", null)],
    [{ kfiId: "2004863", personId: 2004863 }],
  );
  assert.equal(feed.driverTags.length, 1);
  assert.equal(feed.driverTags[0]?.kfiId, "2004863");
});

test("a whitespace-only tag counts as absent", () => {
  const feed = buildDriverTagFeed([driver("2004863", "Jose", "   ")], []);
  assert.deepEqual(feed.driverTags, []);
  assert.equal(feed.taggedDrivers, 0);
});

test("the tag is trimmed on the way out", () => {
  const feed = buildDriverTagFeed([driver("2004863", "Jose", "  10020908 ")], []);
  assert.equal(feed.driverTags[0]?.tagNumber, "10020908");
});

test("no profile row and a null person_id both strand the tag, and both are counted", () => {
  const feed = buildDriverTagFeed(
    [
      driver("2004863", "Jose Angulo Alfaro", "10020908"),
      driver("2005003", "Davidson Alcide", "10020956"),
      driver("2006131", "Maria Cruz", "10020941"),
    ],
    [
      { kfiId: "2004863", personId: 2004863 },
      // Davidson has a profile row, but nobody pinned the PersonId.
      { kfiId: "2005003", personId: null },
      // Maria has no profile row at all.
    ],
  );
  assert.equal(feed.taggedDrivers, 3);
  assert.equal(feed.taggedNoPersonId, 2);
  const byKfi = new Map(feed.driverTags.map((r) => [r.kfiId, r.personId]));
  assert.equal(byKfi.get("2004863"), 2004863);
  assert.equal(byKfi.get("2005003"), null);
  assert.equal(byKfi.get("2006131"), null);
});

test("taggedDrivers counts the stranded rows too, so the denominator is not the joinable subset", () => {
  const feed = buildDriverTagFeed(
    [driver("a", "Ana", "1"), driver("b", "Bo", "2")],
    [{ kfiId: "a", personId: 100 }],
  );
  assert.equal(feed.taggedDrivers, 2);
  assert.equal(feed.taggedNoPersonId, 1);
});

test("two drivers may share one tag — they share the van", () => {
  // Real data: Luis Ceballos and Felix Baez Caballero both carry 10020926.
  // Nothing here may dedupe that; the tag is a vehicle, not a badge.
  const feed = buildDriverTagFeed(
    [driver("2003301", "Luis Ceballos", "10020926"), driver("2003283", "Felix Baez Caballero", "10020926")],
    [
      { kfiId: "2003301", personId: 2003301 },
      { kfiId: "2003283", personId: 2003283 },
    ],
  );
  assert.equal(feed.driverTags.length, 2);
  assert.deepEqual(
    feed.driverTags.map((r) => r.tagNumber),
    ["10020926", "10020926"],
  );
});

test("rows are sorted by name so two pulls diff cleanly", () => {
  const feed = buildDriverTagFeed(
    [driver("c", "Zed", "3"), driver("a", "Ana", "1"), driver("b", "Mia", "2")],
    [],
  );
  assert.deepEqual(
    feed.driverTags.map((r) => r.name),
    ["Ana", "Mia", "Zed"],
  );
});

test("tagUpdatedAt is ISO-8601 or null", () => {
  const at = new Date("2026-09-02T17:26:39.000Z");
  const feed = buildDriverTagFeed(
    [driver("a", "Ana", "1", at), driver("b", "Bo", "2", null)],
    [],
  );
  assert.equal(feed.driverTags[0]?.tagUpdatedAt, "2026-09-02T17:26:39.000Z");
  assert.equal(feed.driverTags[1]?.tagUpdatedAt, null);
});

test("⚠️ the row carries EXACTLY five fields — no SSN, no rate, ever", () => {
  // driver_payroll_profiles holds an SSN and eight rate columns, and this feed
  // reads the PersonId out of that same table. Nothing enforces the file's
  // "NO SSNs AND NO RATES" header except this assertion.
  const feed = buildDriverTagFeed(
    [driver("2004863", "Jose", "10020908")],
    [{ kfiId: "2004863", personId: 2004863 }],
  );
  assert.deepEqual(Object.keys(feed.driverTags[0] ?? {}).sort(), [
    "kfiId",
    "name",
    "personId",
    "tagNumber",
    "tagUpdatedAt",
  ]);
});
