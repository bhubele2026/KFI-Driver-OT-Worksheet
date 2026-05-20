import { logger } from "../logger.js";

/** Minimal logger shape — accepts req.log (pino child) or the module logger. */
export type SalvageLogger = {
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

/**
 * Strip markdown code fences ("```json … ```") that some providers
 * wrap structured-output responses in despite an explicit
 * "JSON only, no markdown fences" system instruction (Claude Sonnet
 * does this intermittently on long extractions — Task #293 follow-up).
 * Cheap, safe, and provider-agnostic; runs before every JSON.parse
 * attempt so both the happy path and the salvage path benefit.
 */
export function stripJsonFences(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```")) {
    // Drop the opening fence plus an optional language tag on the same line.
    const firstNl = s.indexOf("\n");
    if (firstNl !== -1) s = s.slice(firstNl + 1);
    if (s.endsWith("```")) s = s.slice(0, -3);
    s = s.trim();
  }
  return s;
}

/**
 * Find the smallest prefix of `raw` that ends at the matching `}` of
 * the first outer `{ ... }` object, respecting string state so braces
 * inside quoted strings don't count. Returns `null` if there is no
 * outer object or its closing brace is not present.
 */
export function findOuterObjectPrefix(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

export interface SalvageOptions {
  /** Logger used for partial-recovery warnings. Defaults to the module logger. */
  log?: SalvageLogger;
  /** Extra structured context merged into the salvage warning logs. */
  logCtx?: Record<string, unknown>;
  /**
   * Prefix used in thrown error messages and log msgs, e.g.
   * "AI extraction" or "DeLallo OCR fallback".
   */
  errorPrefix: string;
}

export interface SalvageResult<T> {
  parsed: T;
  truncated: boolean;
}

/**
 * Parse a JSON object of the shape `{ "<key>": [ {…}, {…}, … ] }`
 * with progressive recovery for slightly malformed model output:
 *
 *   1. Strip markdown code fences and try `JSON.parse` directly.
 *   2. If that fails, try parsing just the first balanced `{ … }` prefix
 *      (handles trailing prose or duplicate object blocks after the
 *      real payload).
 *   3. If that still fails, walk the first `[ … ]` array and keep the
 *      longest prefix of complete row objects, then re-close as `]}`.
 *      Stops at the matching `]` so trailing garbage past the array
 *      doesn't influence the recovered prefix.
 *
 * Throws an `Error` whose message starts with `${errorPrefix}:` when
 * nothing can be recovered — preserving the original `JSON.parse`
 * message in parentheses so existing observability still matches.
 */
export function parseOrSalvageJsonObject<T = unknown>(
  raw: string,
  opts: SalvageOptions,
): SalvageResult<T> {
  const log = opts.log ?? logger;
  const ctx = opts.logCtx ?? {};
  raw = stripJsonFences(raw);
  let firstErr: Error;
  try {
    return { parsed: JSON.parse(raw) as T, truncated: false };
  } catch (err) {
    firstErr = err as Error;
  }

  const prefix = findOuterObjectPrefix(raw);
  if (prefix !== null) {
    try {
      const parsed = JSON.parse(prefix) as T;
      log.warn(
        {
          ...ctx,
          rawLen: raw.length,
          prefixLen: prefix.length,
        },
        `${opts.errorPrefix}: salvaged JSON prefix (trailing garbage after outer object)`,
      );
      return { parsed, truncated: false };
    } catch {
      // fall through to row-by-row salvage
    }
  }

  const rowsStart = raw.indexOf("[");
  if (rowsStart === -1) {
    throw new Error(
      `${opts.errorPrefix}: model did not return valid JSON and could not be salvaged (${firstErr.message}).`,
    );
  }
  let i = rowsStart + 1;
  let lastGood = -1; // index just after the last balanced row obj
  let depth = 0;
  let inStr = false;
  let esc = false;
  while (i < raw.length) {
    const ch = raw[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) lastGood = i + 1;
    } else if (ch === "]" && depth === 0) {
      break;
    }
    i++;
  }
  if (lastGood === -1) {
    throw new Error(
      `${opts.errorPrefix}: model response was truncated before any complete row could be recovered (${firstErr.message}).`,
    );
  }
  const salvaged = `${raw.slice(0, lastGood)}]}`;
  try {
    const parsed = JSON.parse(salvaged) as T;
    log.warn(
      {
        ...ctx,
        rawLen: raw.length,
        salvagedLen: salvaged.length,
      },
      `${opts.errorPrefix}: salvaged truncated JSON response`,
    );
    return { parsed, truncated: true };
  } catch (err2) {
    throw new Error(
      `${opts.errorPrefix}: model response was truncated and salvage failed (${(err2 as Error).message}).`,
    );
  }
}
