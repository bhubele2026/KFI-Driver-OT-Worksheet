import Anthropic from "@anthropic-ai/sdk";
import type { ContentPart, ModelClient } from "./modelClient.js";

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
 * Convert our provider-agnostic `ContentPart[]` into the message-content
 * shape Anthropic's SDK expects. Claude accepts inline base64 images and
 * a `document` block for PDFs — both are exercised here so the existing
 * image + scanned-PDF code paths in `aiExtract.ts` keep working without
 * provider-specific branching upstream.
 */
function toClaudeContent(parts: ContentPart[]): Anthropic.Messages.ContentBlockParam[] {
  const out: Anthropic.Messages.ContentBlockParam[] = [];
  for (const p of parts) {
    if (p.kind === "text") {
      out.push({ type: "text", text: p.text });
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
  }): Promise<{ text: string }> {
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
        // System reinforces the prompt's "strictly JSON" instruction —
        // Claude follows this reliably on Sonnet+, and `parseOrSalvage`
        // catches the rare format slip the same way it did for Gemini.
        system:
          "You are a payroll-data extractor for a logistics dispatcher. You read customer-supplied timecard documents (spreadsheets, PDFs, photos) and return a single raw JSON object matching the shape described in the user message. Never wrap the JSON in markdown fences. Never add prose, preamble, or commentary before or after the JSON. Start your reply with '{' and end it with '}'. Accuracy matters more than coverage — do not invent rows, drivers, dates, or times that are not in the document.",
        messages: [{ role: "user", content }],
      },
      { timeout: opts.timeoutMs },
    );
    const response = await stream.finalMessage();
    const text = response.content
      .filter((c): c is Anthropic.Messages.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("");
    return { text };
  }
}
