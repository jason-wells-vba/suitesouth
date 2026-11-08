import { NextResponse } from "next/server";
import { redeemCode, refreshTokens } from "@/lib/oauth";

export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/** OAuth token endpoint. Accepts form-encoded or JSON bodies. */
export async function POST(request: Request) {
  const body = await readBody(request);
  const grant = String(body.grant_type ?? "");

  const result =
    grant === "authorization_code"
      ? redeemCode({
          code: String(body.code ?? ""),
          codeVerifier: String(body.code_verifier ?? ""),
          redirectUri: body.redirect_uri ? String(body.redirect_uri) : null,
          clientId: body.client_id ? String(body.client_id) : null,
        })
      : grant === "refresh_token"
        ? refreshTokens(String(body.refresh_token ?? ""))
        : { error: "unsupported_grant_type", error_description: "Use authorization_code or refresh_token." };

  const status = "error" in result ? 400 : 200;
  return NextResponse.json(result, { status, headers: { ...CORS, "Cache-Control": "no-store", Pragma: "no-cache" } });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      const parsed: unknown = await request.json();
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  const text = await request.text();
  return Object.fromEntries(new URLSearchParams(text).entries());
}
