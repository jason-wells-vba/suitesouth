import { NextResponse } from "next/server";
import { verifyPassword } from "@/lib/auth";
import { issueCode, parseAuthorizeRequest, type AuthorizeRequest } from "@/lib/oauth";

export const dynamic = "force-dynamic";

/**
 * OAuth authorization endpoint. GET shows the password form; POST checks the
 * shared site password and sends the client back with a one-time code.
 * Plain HTML on purpose: this page opens inside another product's sign-in
 * popup and should not depend on the app shell.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const parsed = parseAuthorizeRequest(params);
  if (typeof parsed === "string") return page({ error: parsed, params, invalid: true });
  return page({ error: null, params, invalid: false, req: parsed });
}

export async function POST(request: Request) {
  const form = await request.formData();
  const params = new URLSearchParams();
  for (const key of ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope"]) {
    const v = form.get(key);
    if (typeof v === "string" && v) params.set(key, v);
  }
  const parsed = parseAuthorizeRequest(params);
  if (typeof parsed === "string") return page({ error: parsed, params, invalid: true });

  let ok = false;
  try {
    ok = verifyPassword(String(form.get("password") ?? ""));
  } catch {
    return page({ error: "Server is not configured: APP_PASSWORD is missing.", params, invalid: false, req: parsed });
  }
  if (!ok) return page({ error: "Incorrect password.", params, invalid: false, req: parsed }, 401);

  const target = new URL(parsed.redirectUri);
  target.searchParams.set("code", issueCode(parsed));
  if (parsed.state) target.searchParams.set("state", parsed.state);
  return NextResponse.redirect(target, 303);
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

function page(
  opts: { error: string | null; params: URLSearchParams; invalid: boolean; req?: AuthorizeRequest },
  status = opts.invalid ? 400 : 200,
) {
  const hidden = [...opts.params.entries()]
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("\n        ");
  const who = opts.req ? esc(opts.req.clientId) : "an app";
  const body = opts.invalid
    ? `<p class="err">${esc(opts.error ?? "Bad request.")}</p>
       <p class="muted">The connecting app sent an invalid request. Go back and try again.</p>`
    : `<p class="muted">Enter the shared password to let <strong>${who}</strong> read and log stays on your behalf.</p>
       ${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ""}
       <form method="post">
        ${hidden}
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
        <button type="submit">Allow access</button>
       </form>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Suite South — Sign in</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
  main{width:100%;max-width:360px}
  h1{font-size:1.5rem;margin:0 0 4px}
  .muted{color:#64748b;font-size:.9rem;margin:0 0 16px}
  .err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:12px;padding:10px 14px;font-size:.9rem;font-weight:500}
  label{display:block;font-size:.85rem;font-weight:600;margin:12px 0 6px}
  input[type=password]{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:10px;padding:10px 12px;font-size:1rem}
  button{margin-top:16px;width:100%;border:0;border-radius:10px;background:#0f172a;color:#fff;font-weight:600;padding:11px;font-size:1rem;cursor:pointer}
</style></head>
<body><main><h1>Suite South</h1>${body}</main></body></html>`;

  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
