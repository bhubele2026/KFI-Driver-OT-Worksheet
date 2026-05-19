// Defense-in-depth: mirror of the server-side `toDisplayName` helper in
// `artifacts/api-server/src/lib/parsers/displayName.ts`. Keep the two in
// sync. The dashboard and driver-detail header pipe stored driver names
// through this so even a historical export or stale cached payload that
// still has ALL-CAPS names renders cleanly.

const ROMAN_NUMERAL =
  /^(?:M{0,3})(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

function isRomanNumeral(word: string): boolean {
  if (word.length === 0 || word.length > 4) return false;
  const upper = word.toUpperCase();
  if (!/^[IVX]+$/.test(upper)) return false;
  return ROMAN_NUMERAL.test(upper) && upper !== "";
}

function isInitial(word: string): boolean {
  return /^\p{L}\.$/u.test(word);
}

function capFirstRestLower(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toLocaleUpperCase() + s.slice(1).toLocaleLowerCase();
}

function capWord(word: string): string {
  if (word.length === 0) return word;
  if (isInitial(word)) return word.charAt(0).toLocaleUpperCase() + ".";
  if (isRomanNumeral(word)) return word.toUpperCase();
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
  if (!/['\u2019]/.test(part)) return capWord(part);
  const segs = part.split(/(['\u2019])/);
  return segs
    .map((seg, i) => {
      if (seg === "'" || seg === "\u2019") return seg;
      const prev = segs[i - 1];
      if (prev === "'" || prev === "\u2019") return capFirstRestLower(seg);
      return capWord(seg);
    })
    .join("");
}

function capHyphenated(token: string): string {
  if (!token.includes("-")) return capApostropheAware(token);
  return token.split("-").map(capApostropheAware).join("-");
}

export function formatPersonName(input: string | null | undefined): string {
  if (input == null) return "";
  const trimmed = input.trim();
  if (!trimmed) return input ?? "";
  const letters = trimmed.replace(/[^\p{L}]/gu, "");
  if (letters.length === 0) return input;
  const hasUpper = letters !== letters.toLocaleLowerCase();
  const hasLower = letters !== letters.toLocaleUpperCase();
  if (hasUpper && hasLower) return input;
  return trimmed.split(/\s+/).map(capHyphenated).join(" ");
}
