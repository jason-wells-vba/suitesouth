import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { verifyAccessToken } from "../oauth.ts";

/**
 * Machine access (REST and MCP) accepts either:
 *  - the static API_KEY, as `Authorization: Bearer <key>` or `x-api-key: <key>`,
 *    for scripts and clients that can paste a key; or
 *  - an OAuth access token minted by /oauth/token, for clients such as Grok
 *    that insist on an OAuth flow.
 * Both are separate from the password people type into the site.
 */
export function readBearer(request: Request): string | null {
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
  | { ok: true; via: "api_key" | "oauth" }
  | { ok: false; status: 401 | 503; message: string };

export function checkApiKey(request: Request): ApiAuth {
  const expected = process.env.API_KEY;
  if (!expected) {
    return { ok: false, status: 503, message: "API_KEY is not configured on the server." };
  }
  const given = readBearer(request);
  if (!given) return { ok: false, status: 401, message: "Missing API key or access token." };
  if (constantTimeEqual(given, expected)) return { ok: true, via: "api_key" };
  // Signed tokens contain a dot; the static key never does. Cheap pre-check.
  if (given.includes(".") && verifyAccessToken(given)) return { ok: true, via: "oauth" };
  return { ok: false, status: 401, message: "Missing or invalid API key." };
}
