import { GoogleGenAI } from "@google/genai";
import type { ContentPart, ModelClient } from "./modelClient.js";

let _ai: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (_ai) return _ai;
  const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  if (!apiKey || !baseUrl) {
    throw new Error(
      "AI extraction unavailable: AI_INTEGRATIONS_GEMINI_API_KEY / AI_INTEGRATIONS_GEMINI_BASE_URL not configured.",
    );
  }
  _ai = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: "", baseUrl },
  });
  return _ai;
}

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

/**
 * Provider-agnostic adapter for Gemini. Kept thin so the chunking math,
 * salvage path, and prompt shape stay in `aiExtract.ts` — this only
 * translates a `ContentPart[]` payload into Gemini's `contents.parts`
 * format and applies the per-call Promise.race timeout (the @google/genai
 * SDK doesn't expose AbortSignal on generateContent here).
 */
export class GeminiModelClient implements ModelClient {
  readonly name = "gemini";
  private readonly model: string;

  constructor(model?: string) {
    this.model = model ?? process.env.GEMINI_EXTRACT_MODEL ?? DEFAULT_GEMINI_MODEL;
  }

  async generate(opts: {
    parts: ContentPart[];
    maxOutputTokens: number;
    timeoutMs: number;
    jsonSchema?: unknown;
  }): Promise<{ text: string }> {
    const ai = getGeminiClient();
    const geminiParts = opts.parts.map((p) =>
      p.kind === "text"
        ? { text: p.text }
        : { inlineData: { mimeType: p.mimeType, data: p.data } },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `AI extraction timed out after ${Math.round(opts.timeoutMs / 1000)}s — retry in a moment.`,
          ),
        );
      }, opts.timeoutMs);
    });
    const generate = ai.models.generateContent({
      model: this.model,
      contents: [{ role: "user", parts: geminiParts }],
      config: {
        responseMimeType: "application/json",
        ...(opts.jsonSchema ? { responseSchema: opts.jsonSchema as never } : {}),
        maxOutputTokens: opts.maxOutputTokens,
      },
    });
    let response;
    try {
      response = await Promise.race([generate, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return { text: response.text ?? "" };
  }
}
