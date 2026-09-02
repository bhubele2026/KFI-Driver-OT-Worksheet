/**
 * The Create-PDF queue — the pure pieces of the machine bridge's `pdf-claim`
 * and `pdf-result` kinds, kept out of the route so tests can pin them.
 *
 * Lifecycle on a change row: null → requested (the board's button) →
 * filed | failed (the Mac-side executor reporting back). Only the executor may
 * say "filed", and it must never say it unless the PDF is verifiably on disk
 * in the synced SharePoint folder — a link on the board that 404s teaches a
 * processor to distrust every link on the board.
 */

/**
 * Clamp a requested long-poll hold to what the ingress tolerates: Azure
 * Container Apps cuts a request around 240s, and a 504 mid-hold teaches the
 * daemon to treat healthy silence as failure. 230s leaves room to answer.
 */
export function clampWaitMs(input: unknown): number {
  const n = Number(input ?? 230);
  const s = Number.isFinite(n) ? n : 230;
  return Math.min(Math.max(s, 5), 230) * 1000;
}

export type PdfResult = {
  periodId: number;
  rowKey: string;
  outcome: "filed" | "failed";
  webUrl?: string;
  fileName?: string;
  error?: string;
};

export function validatePdfResult(
  r: unknown,
): { ok: true; result: PdfResult } | { ok: false; error: string } {
  if (typeof r !== "object" || r === null) {
    return { ok: false, error: "each result must be an object" };
  }
  const o = r as Record<string, unknown>;
  if (!Number.isInteger(o["periodId"])) {
    return { ok: false, error: "periodId must be an integer" };
  }
  if (typeof o["rowKey"] !== "string" || o["rowKey"].length === 0) {
    return { ok: false, error: "rowKey is required" };
  }
  if (o["outcome"] !== "filed" && o["outcome"] !== "failed") {
    return { ok: false, error: "outcome must be 'filed' or 'failed'" };
  }
  // A filed result without a link would put a dead "PDF filed" chip on the
  // board; a failed one without a reason gives the processor nothing to act on.
  if (o["outcome"] === "filed"
      && (typeof o["webUrl"] !== "string" || !o["webUrl"].startsWith("https://"))) {
    return { ok: false, error: "a filed result must carry the SharePoint webUrl" };
  }
  if (o["outcome"] === "failed"
      && (typeof o["error"] !== "string" || o["error"].trim() === "")) {
    return { ok: false, error: "a failed result must say why — the board shows the reason" };
  }
  return {
    ok: true,
    result: {
      periodId: o["periodId"] as number,
      rowKey: o["rowKey"],
      outcome: o["outcome"],
      webUrl: typeof o["webUrl"] === "string" ? o["webUrl"] : undefined,
      fileName: typeof o["fileName"] === "string" ? o["fileName"] : undefined,
      error: typeof o["error"] === "string" ? o["error"] : undefined,
    },
  };
}

/**
 * The columns one result writes. Filed clears any earlier error and stamps the
 * link; failed records the reason and touches nothing else — an older filed
 * link deliberately survives a later failure, since the earlier PDF is still
 * where the link says it is.
 */
export function pdfResultPatch(r: PdfResult, now: Date): Record<string, unknown> {
  if (r.outcome === "filed") {
    const patch: Record<string, unknown> = {
      pdfStatus: "filed", pdfFiledAt: now, pdfWebUrl: r.webUrl ?? null,
      pdfError: null, updatedAt: now,
    };
    if (r.fileName) patch["fileNaming"] = r.fileName;
    return patch;
  }
  return { pdfStatus: "failed", pdfError: r.error ?? "failed", updatedAt: now };
}
