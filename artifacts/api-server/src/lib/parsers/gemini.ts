import { GoogleGenAI } from "@google/genai";

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
