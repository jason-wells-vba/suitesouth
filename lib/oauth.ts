import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * A minimal OAuth 2.1 authorization server, enough for MCP clients such as
 * Grok and Claude that insist on OAuth rather than a pasted key.
 *
 * There is no user database. The person signs in with the site's shared
 * password; the tokens are HMAC-signed JSON (same secret as the session
 * cookie), so nothing is stored and nothing needs a migration.
 *
 * Flow: GET /oauth/authorize shows the password form; POST verifies, mints a
 * short-lived code bound to the PKCE challenge and redirect URI, redirects
 * back; POST /oauth/token swaps code + verifier for an access token.
 */

const CODE_TTL_S = 5 * 60;
const ACCESS_TTL_S = 60 * 60 * 24 * 30; // 30 days, same as the session cookie
const REFRESH_TTL_S = 60 * 60 * 24 * 180;

type Payload = Record<string, unknown> & { kind: "code" | "access" | "refresh"; exp: number };

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return s;
}

const b64 = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

function sign(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

function mint(payload: Payload): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

function open(token: string, kind: Payload["kind"]): Payload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  let expected: Buffer;
  try {
    expected = Buffer.from(sign(body));
  } catch {
    return null;
  }
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as Payload;
    if (payload.kind !== kind) return null;
    if (typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

const now = () => Math.floor(Date.now() / 1000);

export type AuthorizeRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  state: string | null;
  scope: string | null;
};

/** Validates the query of /oauth/authorize. Returns an error message or the request. */
export function parseAuthorizeRequest(params: URLSearchParams): AuthorizeRequest | string {
  if (params.get("response_type") !== "code") return "response_type must be code.";
  const clientId = params.get("client_id")?.trim() ?? "";
  if (!clientId) return "client_id is required.";
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!isAcceptableRedirect(redirectUri)) return "redirect_uri must be an https URL (or http://localhost).";
  const codeChallenge = params.get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) return "A PKCE code_challenge is required.";
  const method = params.get("code_challenge_method") ?? "S256";
  if (method !== "S256") return "code_challenge_method must be S256.";
  return {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod: "S256",
    state: params.get("state"),
    scope: params.get("scope"),
  };
}

function isAcceptableRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

export function issueCode(req: AuthorizeRequest): string {
  return mint({
    kind: "code",
    exp: now() + CODE_TTL_S,
    cid: req.clientId,
    ruri: req.redirectUri,
    cc: req.codeChallenge,
    scope: req.scope,
    nonce: randomBytes(8).toString("hex"),
  });
}

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope?: string;
};

function issueTokens(clientId: string, scope: string | null): TokenResponse {
  const sid = randomBytes(8).toString("hex");
  return {
    access_token: mint({ kind: "access", exp: now() + ACCESS_TTL_S, cid: clientId, sid }),
    token_type: "Bearer",
    expires_in: ACCESS_TTL_S,
    refresh_token: mint({ kind: "refresh", exp: now() + REFRESH_TTL_S, cid: clientId, sid, scope }),
    ...(scope ? { scope } : {}),
  };
}

export type TokenError = { error: string; error_description: string };

export function redeemCode(args: {
  code: string;
  codeVerifier: string;
  redirectUri: string | null;
  clientId: string | null;
}): TokenResponse | TokenError {
  const payload = open(args.code, "code");
  if (!payload) return { error: "invalid_grant", error_description: "Code is invalid or expired." };
  if (args.redirectUri && args.redirectUri !== payload.ruri) {
    return { error: "invalid_grant", error_description: "redirect_uri does not match." };
  }
  if (args.clientId && args.clientId !== payload.cid) {
    return { error: "invalid_client", error_description: "client_id does not match." };
  }
  const challenge = createHash("sha256").update(args.codeVerifier).digest("base64url");
  if (challenge !== payload.cc) {
    return { error: "invalid_grant", error_description: "PKCE verification failed." };
  }
  return issueTokens(String(payload.cid), (payload.scope as string | null) ?? null);
}

export function refreshTokens(refreshToken: string): TokenResponse | TokenError {
  const payload = open(refreshToken, "refresh");
  if (!payload) return { error: "invalid_grant", error_description: "Refresh token is invalid or expired." };
  return issueTokens(String(payload.cid), (payload.scope as string | null) ?? null);
}

/** True when the bearer token is an access token this server minted. */
export function verifyAccessToken(token: string): boolean {
  return open(token, "access") !== null;
}
