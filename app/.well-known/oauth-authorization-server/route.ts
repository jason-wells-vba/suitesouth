import { NextResponse } from "next/server";
import { authorizationServerMetadata, CORS } from "@/lib/oauth-metadata";

export const dynamic = "force-dynamic";

/** RFC 8414 discovery, so MCP clients can find /oauth/authorize and /oauth/token. */
export function GET(request: Request) {
  return NextResponse.json(authorizationServerMetadata(request), { headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
