import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dedupeHeaders, prefilterVerdict } from "../prefilter";
import type { MailHeader } from "../graphMail";

const h = (over: Partial<MailHeader>): MailHeader => ({
  id: "g1", internetMessageId: "<a@x>", conversationId: "c1",
  subject: "", from: "someone@kfi.group", fromName: "Someone",
  to: ["payroll@kfistaffing.com"], cc: [], receivedAt: "2026-09-10T12:00:00Z",
  sentAt: null, categories: [], hasAttachments: false, parentFolderId: null,
  bodyPreview: "hello", ...over,
});

describe("prefilter — recall is the whole point", () => {
  it("keeps a bare person's name as the subject", () => {
    // 9 of 59 real candidates looked exactly like this: no keyword, no tag,
    // and a live payroll change inside.
    assert.equal(prefilterVerdict(h({ subject: "David Arroyo" })).keep, true);
    assert.equal(prefilterVerdict(h({ subject: "RE: Cruz Sanchez" })).keep, true);
  });

  it("keeps the two near-misses a keyword filter would have dropped", () => {
    // A08: a timesheet-shaped subject carrying the Labor Day holiday-pay list.
    assert.equal(prefilterVerdict(h({
      subject: "Timesheets week of 9-7-26",
      from: "maura.mckee@shusters.com",
      categories: ["Holiday", "Tiana"],
    })).keep, true);

    // A13: a pay-summary-shaped subject carrying the safety bonus.
    assert.equal(prefilterVerdict(h({
      subject: "Re: Trienda's KFI Pay Summary W/E 9/12/2026",
      categories: ["Bonus"],
    })).keep, true);
  });

  it("lets a category override every skip rule", () => {
    const v = prefilterVerdict(h({
      subject: "Invoice Report for Central Wisconsin Finishing",
      categories: ["Refunds"],
    }));
    assert.equal(v.keep, true);
    assert.ok(v.reason.includes("categorised"));
  });

  it("does not treat a bare colour category as a tag", () => {
    // "Green Category" names a colour, not a meaning.
    assert.equal(prefilterVerdict(h({
      subject: "Invoice Report for Something",
      categories: ["Green Category"],
    })).keep, false);
  });

  it("drops unambiguous machine senders and notices", () => {
    assert.equal(prefilterVerdict(h({ from: "no-reply@zenople.com" })).keep, false);
    assert.equal(prefilterVerdict(h({ from: "noreply@asure.com" })).keep, false);
    assert.equal(prefilterVerdict(h({ subject: "[Postmaster] Messages on hold" })).keep, false);
    assert.equal(prefilterVerdict(h({ subject: "Accepted: Payroll sync" })).keep, false);
  });
});

describe("dedupeHeaders", () => {
  it("collapses folder copies on internetMessageId, not the Graph id", () => {
    // The same message filed into a PD subfolder comes back with a DIFFERENT
    // Graph id. Deduping on `id` would classify it twice.
    const rows = dedupeHeaders([
      h({ id: "inbox-copy", internetMessageId: "<same@x>" }),
      h({ id: "filed-copy", internetMessageId: "<same@x>" }),
      h({ id: "other", internetMessageId: "<other@x>" }),
    ]);
    assert.equal(rows.length, 2);
  });
});
