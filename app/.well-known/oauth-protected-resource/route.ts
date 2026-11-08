import { NextResponse } from "next/server";
import { CORS, origin } from "@/lib/oauth-metadata";

export const dynamic = "force-dynamic";

/** RFC 9728: tells an MCP client which authorization server protects /api/mcp. */
export function GET(request: Request) {
  const base = origin(request);
  return NextResponse.json(
    {
      resource: `${base}/api/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      scopes_supported: ["stays"],
    },
    { headers: CORS },
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
