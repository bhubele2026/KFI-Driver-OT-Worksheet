// Person-name normalization shared across ingest sites (Connecteam refresh,
// AI extract suggestions, customer_name_aliases.name_on_doc). The goal is to
// stop ALL-CAPS profile names from leaking into the dispatcher UI: anything
// effectively all-upper or all-lower is rewritten to Title Case; anything
// already mixed-case is left untouched so dispatcher-entered values aren't
// clobbered.
//
// The frontend mirror lives at `artifacts/kfi-ot/src/lib/format-name.ts` —
// keep the two in sync. A short Node implementation also lives in
// `lib/db/src/preMigrate.ts` for the backfill of historical rows.

const ROMAN_NUMERAL = /^(?:M{0,3})(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

function isRomanNumeral(word: string): boolean {
  if (word.length === 0 || word.length > 4) return false;
  const upper = word.toUpperCase();
  // Restrict to the common name suffixes II / III / IV / V / VI / VII / VIII.
  if (!/^[IVX]+$/.test(upper)) return false;
  return ROMAN_NUMERAL.test(upper) && upper !== "";
}

function isInitial(word: string): boolean {
  return /^\p{L}\.$/u.test(word);
}

function capFirstRestLower(s: string): string {
  if (s.length === 0) return s;
  const first = s.charAt(0).toLocaleUpperCase();
  const rest = s.slice(1).toLocaleLowerCase();
  return first + rest;
}

function capWord(word: string): string {
  if (word.length === 0) return word;
  if (isInitial(word)) return word.charAt(0).toLocaleUpperCase() + ".";
  if (isRomanNumeral(word)) return word.toUpperCase();
  // "Mc" prefix → capitalize the letter after Mc as well (McDonald).
  if (/^mc\p{L}/iu.test(word)) {
    return (
      "Mc" +
      word.charAt(2).toLocaleUpperCase() +
      word.slice(3).toLocaleLowerCase()
    );
  }
  return capFirstRestLower(word);
}

function capApostropheAware(part: string): string {
  // Split on both ASCII apostrophe and the curly right-single-quote that
  // sometimes sneaks in from Word / Excel exports.
  if (!/['\u2019]/.test(part)) return capWord(part);
  const segs = part.split(/(['\u2019])/);
  return segs
    .map((seg, i) => {
      if (seg === "'" || seg === "\u2019") return seg;
      const prev = segs[i - 1];
      if (prev === "'" || prev === "\u2019") {
        // Letter group after the apostrophe → just cap the first letter
        // ("O'Brien", "D'Angelo"). Don't recurse into capWord because we
        // don't want the Mc/Roman rules to fire on the post-apostrophe seg.
        return capFirstRestLower(seg);
      }
      return capWord(seg);
    })
    .join("");
}

function capHyphenated(token: string): string {
  if (!token.includes("-")) return capApostropheAware(token);
  return token.split("-").map(capApostropheAware).join("-");
}

/**
 * Convert a person's name to Title Case, but only if the input is
 * effectively all upper or all lower. Mixed-case input is returned
 * unchanged. Returns the input verbatim for empty / whitespace-only strings
 * so callers can pass through optional fields safely.
 */
export function toDisplayName(input: string | null | undefined): string {
  if (input == null) return "";
  const trimmed = input.trim();
  if (!trimmed) return input ?? "";
  const letters = trimmed.replace(/[^\p{L}]/gu, "");
  if (letters.length === 0) return input;
  const hasUpper = letters !== letters.toLocaleLowerCase();
  const hasLower = letters !== letters.toLocaleUpperCase();
  if (hasUpper && hasLower) return input; // mixed case: dispatcher-entered, leave alone
  return trimmed.split(/\s+/).map(capHyphenated).join(" ");
}
