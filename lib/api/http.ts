import "server-only";
import { NextResponse } from "next/server";
import { checkApiKey } from "./auth.ts";
import { StayError } from "../services/stays.ts";

/** Small helpers so every REST route answers in the same shape. */

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function error(status: number, message: string, details: Record<string, unknown> = {}): NextResponse {
  return json({ error: message, ...details }, status);
}

const STATUS_FOR: Record<StayError["code"], number> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
};

type Handler<P> = (request: Request, params: P) => Promise<NextResponse>;

/**
 * Checks the API key, runs the handler, and turns thrown StayErrors into the
 * matching HTTP status. Anything else is logged and answered as a 500.
 */
export function protectedRoute<P = Record<string, never>>(handler: Handler<P>) {
  return async (request: Request, ctx?: { params?: Promise<P> | P }): Promise<NextResponse> => {
    const auth = checkApiKey(request);
    if (!auth.ok) return error(auth.status, auth.message);

    const params = (await ctx?.params) ?? ({} as P);
    try {
      return await handler(request, params);
    } catch (e) {
      if (e instanceof StayError) return error(STATUS_FOR[e.code], e.message, e.details);
      if (e instanceof SyntaxError) return error(400, "Body must be valid JSON.");
      console.error("API route failed", e);
      return error(500, "Something went wrong. Check the server logs.");
    }
  };
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StayError("invalid", "Body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function query(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

/** Reads a field under either naming style; undefined when neither is present. */
export function field(body: Record<string, unknown>, snake: string, camel: string): unknown {
  return body[snake] !== undefined ? body[snake] : body[camel];
}

export function optionalText(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
