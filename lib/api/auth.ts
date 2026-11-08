import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Machine access (REST and MCP) uses a bearer key, separate from the shared
 * password people type into the site, so either can be rotated alone.
 *
 * Accepted as `Authorization: Bearer <key>` or `x-api-key: <key>`.
 */
export function readApiKey(request: Request): string | null {
  const auth = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m) return m[1].trim();
  const header = request.headers.get("x-api-key");
  return header ? header.trim() : null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export type ApiAuth =
  | { ok: true }
  | { ok: false; status: 401 | 503; message: string };

export function checkApiKey(request: Request): ApiAuth {
  const expected = process.env.API_KEY;
  if (!expected) {
    return { ok: false, status: 503, message: "API_KEY is not configured on the server." };
  }
  const given = readApiKey(request);
  if (!given || !constantTimeEqual(given, expected)) {
    return { ok: false, status: 401, message: "Missing or invalid API key." };
  }
  return { ok: true };
}
