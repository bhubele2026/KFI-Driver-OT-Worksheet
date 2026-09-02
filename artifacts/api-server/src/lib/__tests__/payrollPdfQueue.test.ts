import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clampWaitMs, validatePdfResult, pdfResultPatch, type PdfResult,
} from "../payrollPdfQueue";

describe("clampWaitMs — the long-poll hold stays under the ingress timeout", () => {
  it("defaults to 230s and caps anything longer", () => {
    assert.equal(clampWaitMs(undefined), 230_000);
    assert.equal(clampWaitMs(9_999), 230_000);
  });
  it("floors tiny and junk values instead of spinning", () => {
    assert.equal(clampWaitMs(0), 5_000);
    assert.equal(clampWaitMs(-3), 5_000);
    assert.equal(clampWaitMs("junk"), 230_000);
  });
  it("passes a sane ask through", () => {
    assert.equal(clampWaitMs(60), 60_000);
  });
});

const filed = (o: Partial<PdfResult> = {}): PdfResult => ({
  periodId: 7, rowKey: "abc123", outcome: "filed",
  webUrl: "https://penda0.sharepoint.com/sites/KFIPayroll/x.pdf",
  fileName: "MN ESST Fontaine M Juan Perez Email.pdf", ...o,
});

describe("validatePdfResult — what the executor may report", () => {
  it("accepts a filed result with a link", () => {
    const v = validatePdfResult(filed());
    assert.ok(v.ok);
  });

  it("REFUSES filed without a webUrl — a dead 'PDF filed' chip teaches distrust", () => {
    const v = validatePdfResult({ periodId: 7, rowKey: "k", outcome: "filed" });
    assert.ok(!v.ok);
  });

  it("refuses a webUrl that is not https", () => {
    const v = validatePdfResult(filed({ webUrl: "file:///tmp/x.pdf" }));
    assert.ok(!v.ok);
  });

  it("REFUSES failed without a reason — the board shows the why", () => {
    const v = validatePdfResult({ periodId: 7, rowKey: "k", outcome: "failed", error: "  " });
    assert.ok(!v.ok);
  });

  it("accepts failed with a reason", () => {
    const v = validatePdfResult({ periodId: 7, rowKey: "k", outcome: "failed", error: "email not found" });
    assert.ok(v.ok);
  });

  it("refuses an unknown outcome and junk shapes", () => {
    assert.ok(!validatePdfResult({ periodId: 7, rowKey: "k", outcome: "done" }).ok);
    assert.ok(!validatePdfResult({ periodId: "7", rowKey: "k", outcome: "filed" }).ok);
    assert.ok(!validatePdfResult(null).ok);
    assert.ok(!validatePdfResult("filed").ok);
  });
});

describe("pdfResultPatch", () => {
  const now = new Date("2026-09-02T18:00:00Z");

  it("filed stamps the link, clears the error, and names the file", () => {
    const p = pdfResultPatch(filed(), now);
    assert.equal(p["pdfStatus"], "filed");
    assert.equal(p["pdfError"], null);
    assert.equal(p["pdfFiledAt"], now);
    assert.match(String(p["pdfWebUrl"]), /^https:/);
    assert.equal(p["fileNaming"], "MN ESST Fontaine M Juan Perez Email.pdf");
  });

  it("filed without a fileName leaves fileNaming alone", () => {
    const p = pdfResultPatch(filed({ fileName: undefined }), now);
    assert.ok(!("fileNaming" in p));
  });

  it("failed records the reason and DOES NOT touch the filed columns — an earlier PDF is still where its link says", () => {
    const p = pdfResultPatch(
      { periodId: 7, rowKey: "k", outcome: "failed", error: "email not found" }, now);
    assert.equal(p["pdfStatus"], "failed");
    assert.equal(p["pdfError"], "email not found");
    assert.ok(!("pdfWebUrl" in p));
    assert.ok(!("pdfFiledAt" in p));
    assert.ok(!("fileNaming" in p));
  });
});
