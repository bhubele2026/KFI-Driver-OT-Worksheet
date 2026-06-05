/**
 * Task #451: authenticated in-process loopback client for the Worksheet
 * Copilot. Every copilot read/write tool calls the app's own `/api` surface
 * through this helper rather than re-implementing business logic. The
 * inbound copilot request is `requireAuth`, so we forward its session cookie
 * (`kfi.sid`) on each call — this replays every existing guard (locked-week
 * 409, safeBulkDelete threshold, role checks), audit row, deletion snapshot,
 * attribution (createdBy/updatedBy), and realtime publish exactly as if the
 * dispatcher had clicked the button themselves.
 */

export interface LoopbackResult {
  status: number;
  ok: boolean;
  json: unknown;
  text: string;
}

export type LoopbackCall = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<LoopbackResult>;

function baseUrl(): string {
  const port = process.env.PORT;
  if (!port) {
    throw new Error("PORT is required for copilot loopback calls");
  }
  return `http://127.0.0.1:${port}`;
}

/**
 * Build a {@link LoopbackCall} bound to one dispatcher's session cookie.
 * Pass `req.headers.cookie` from the copilot route handler.
 */
export function makeLoopbackCall(cookie: string | undefined): LoopbackCall {
  return async (method, path, body) => {
    if (!path.startsWith("/api")) {
      throw new Error(`copilot loopback path must start with /api: ${path}`);
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, ok: res.ok, json, text };
  };
}
