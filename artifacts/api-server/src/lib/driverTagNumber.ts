// Parse the PATCH /drivers/:kfiId/tag-number body value. The tag number is a
// short badge-style identifier maintained in-app (Connecteam's profile Tags
// feature is not API-readable). Kept as a pure helper so the trim/clear/reject
// contract is unit-testable without an HTTP harness.

export type TagNumberParse =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

export function parseTagNumberInput(raw: unknown): TagNumberParse {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, error: "tagNumber must be a string or null" };
  }
  const trimmed = raw.trim();
  if (trimmed.length > 32 || /[\p{Cc}\p{Cf}]/u.test(trimmed)) {
    return {
      ok: false,
      error: "tagNumber must be at most 32 printable characters",
    };
  }
  return { ok: true, value: trimmed === "" ? null : trimmed };
}
