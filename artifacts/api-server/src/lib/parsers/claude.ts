import Anthropic from "@anthropic-ai/sdk";
import type { ContentPart, ModelCallUsage, ModelClient } from "./modelClient.js";

let _client: Anthropic | null = null;

export function getClaudeClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "AI extraction unavailable: ANTHROPIC_API_KEY is not set. " +
        "Set it in Replit Secrets, or switch to Gemini with AI_EXTRACT_PROVIDER=gemini.",
    );
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

/** Default Claude model used for customer-file extraction. Overridable via env. */
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-5";

/**
 * Default Claude model used for the per-upload reviewer (Task #446). Runs
 * at most once per confirmed upload, so it defaults to the most-capable
 * Opus model for the sharpest verdict. Overridable via
 * `CLAUDE_ANALYSIS_MODEL`.
 */
export const DEFAULT_CLAUDE_ANALYSIS_MODEL = "claude-opus-4-8";

/**
 * Convert our provider-agnostic `ContentPart[]` into the message-content
 * shape Anthropic's SDK expects. Claude accepts inline base64 images and
 * a `document` block for PDFs — both are exercised here so the existing
 * image + scanned-PDF code paths in `aiExtract.ts` keep working without
 * provider-specific branching upstream.
 */
export function _toClaudeContentForTests(parts: ContentPart[]): Anthropic.Messages.ContentBlockParam[] {
  return toClaudeContent(parts);
}

function toClaudeContent(parts: ContentPart[]): Anthropic.Messages.ContentBlockParam[] {
  const out: Anthropic.Messages.ContentBlockParam[] = [];
  for (const p of parts) {
    if (p.kind === "text") {
      // Task #296: when a text block is flagged cacheable, attach
      // Anthropic's `cache_control: { type: "ephemeral" }`. The first
      // chunk of an upload pays the (slightly higher) cache_creation
      // tokens; chunks 2..N hit cache_read at ~10% of the input price
      // AND no longer count those tokens against the per-minute
      // input-tokens rate limit window. That's the whole reason the
      // 71-chunk Adient first-time upload can complete on tier-1 now
      // without thrashing on 429s.
      const block: Anthropic.Messages.TextBlockParam = { type: "text", text: p.text };
      if (p.cacheable) {
        block.cache_control = { type: "ephemeral" };
      }
      out.push(block);
      continue;
    }
    const mt = p.mimeType.toLowerCase();
    if (mt === "application/pdf") {
      out.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: p.data },
      });
    } else if (mt.startsWith("image/")) {
      // Claude image media types are a closed enum; map common ones,
      // and fall through to image/jpeg for anything we don't recognise
      // (matches `aiExtract.ts`'s normalize-on-ingest behaviour where
      // unknown inputs are transcoded to JPEG before reaching this path).
      const allowed = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
      const mediaType = (allowed.has(mt) ? mt : "image/jpeg") as
        | "image/jpeg"
        | "image/png"
        | "image/gif"
        | "image/webp";
      out.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: p.data },
      });
    } else {
      // Unknown binary mimetype — convert to a text note so the model
      // still has context rather than silently dropping the payload.
      out.push({ type: "text", text: `[Unsupported inline attachment: ${p.mimeType}]` });
    }
  }
  return out;
}

export class ClaudeModelClient implements ModelClient {
  readonly name = "claude";
  private readonly model: string;

  constructor(model?: string) {
    this.model = model ?? process.env.CLAUDE_EXTRACT_MODEL ?? DEFAULT_CLAUDE_MODEL;
  }

  async generate(opts: {
    parts: ContentPart[];
    maxOutputTokens: number;
    timeoutMs: number;
  }): Promise<{ text: string; usage: ModelCallUsage }> {
    const client = getClaudeClient();
    const content = toClaudeContent(opts.parts);
    // Claude's per-request `max_tokens` ceiling for Sonnet 4.5 currently
    // sits at 64k; we cap our request at 32k to mirror the Gemini path's
    // budget and to keep the cost/latency profile of the existing
    // chunking math unchanged.
    // The Anthropic SDK refuses non-streaming requests whose configured
    // `max_tokens` could push the call past its 10-minute internal
    // ceiling — at 32k output tokens we're well inside that band, so
    // it throws "Streaming is required for operations that may take
    // longer than 10 minutes" before the request even goes out.
    // Switching to `.stream(...)` + `finalMessage()` keeps the same
    // semantics (we still wait for the full response) without
    // re-plumbing the caller, and it neatly survives slow first-token
    // pauses inside our outer timeout race in `aiExtract.ts`.
    const stream = client.messages.stream(
      {
        model: this.model,
        max_tokens: Math.min(opts.maxOutputTokens, 32768),
        // System reinforces the prompt's "strictly NDJSON" instruction
        // (Task #308) — one JSON object per line, no fences, no prose.
        // The per-line parser tolerates blank lines so a stray trailing
        // newline isn't fatal, but anything else (preamble, markdown,
        // commentary) leaks into the parseFailedLines counter and shows
        // up in the per-chunk telemetry log.
        system:
          "You are a payroll-data extractor for a logistics dispatcher. You read customer-supplied timecard documents (spreadsheets, PDFs, photos) and return NDJSON: one JSON object per line, separated by single newlines. Each line is a complete `{...}` object — never wrap the stream in an array, never wrap any line in markdown fences, never add prose, preamble, or commentary before, between, or after the lines. Accuracy matters more than coverage — do not invent rows, drivers, dates, or times that are not in the document.",
        messages: [{ role: "user", content }],
      },
      { timeout: opts.timeoutMs },
    );
    const response = await stream.finalMessage();
    const text = response.content
      .filter((c): c is Anthropic.Messages.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("");
    // Claude's Usage object reports prompt + completion tokens separately.
    // We fold cache-creation / cache-read tokens into the input bucket so
    // the per-upload token ceiling counts the full real input volume
    // regardless of how prompt caching (planned in Task #296) eventually
    // splits them.
    const u = response.usage;
    const inputTokens =
      (u?.input_tokens ?? 0) +
      (u?.cache_creation_input_tokens ?? 0) +
      (u?.cache_read_input_tokens ?? 0);
    const outputTokens = u?.output_tokens ?? 0;
    return {
      text,
      usage: {
        inputTokens,
        outputTokens,
        model: this.model,
        provider: this.name,
      },
    };
  }
}
