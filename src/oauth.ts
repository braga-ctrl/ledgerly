import type { Context, Hono } from "hono";
import { authenticate } from "./services";
import { randomKey, sha256Hex, uid } from "./util";

/**
 * Minimal OAuth 2.0 authorization server for the MCP endpoint:
 *  - Protected Resource Metadata (RFC 9728) and Authorization Server Metadata (RFC 8414)
 *  - Dynamic Client Registration (RFC 7591), public clients only
 *  - Authorization Code + PKCE (S256 only), single-use codes
 *  - Access tokens (1 h) and rotating refresh tokens (30 d) with reuse detection
 *
 * The "sign in" step asks for the workspace API key. That is a stand-in for your real
 * login (SSO, user accounts): replace `renderConsent` / the POST /authorize check when you have one.
 */

const SCOPE = "ledgerly";
const CODE_TTL = 600;
const ACCESS_TTL = 3600;
const REFRESH_TTL = 60 * 60 * 24 * 30;
const now = () => Math.floor(Date.now() / 1000);

type C = Context<{ Bindings: { DB: D1Database } }>;
const originOf = (c: C) => new URL(c.req.url).origin;

export const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource`;

/** Accepts either a workspace API key (lgk_…) or an OAuth access token (lga_…). */
export async function authenticateAny(db: D1Database, token: string | null): Promise<string | null> {
  if (!token) return null;
  if (token.startsWith("lgk_")) return authenticate(db, token);
  if (token.startsWith("lga_")) {
    const row = await db
      .prepare("SELECT org_id FROM oauth_tokens WHERE token_hash=? AND kind='access' AND expires_at > ?")
      .bind(await sha256Hex(token), now())
      .first<{ org_id: string }>();
    return row?.org_id ?? null;
  }
  return null;
}

// ---- helpers ------------------------------------------------------------------

const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" };

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function s256(verifier: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function validRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
  } catch {
    return false;
  }
}

/** Exact match, except loopback redirects may differ in port (RFC 8252 section 7.3). */
function redirectAllowed(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  try {
    const g = new URL(given);
    if (g.protocol !== "http:" || !LOOPBACK.has(g.hostname)) return false;
    return registered.some((r) => {
      const u = new URL(r);
      return u.protocol === "http:" && u.hostname === g.hostname && u.pathname === g.pathname;
    });
  } catch {
    return false;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function htmlPage(body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ledgerly: connect</title>
<style>
:root{--bg:#f5f4ef;--panel:#fff;--ink:#1d2126;--muted:#69707a;--line:#e3e0d8;--accent:#0e6b5c;--accent-ink:#fff;--bad:#b3261e}
@media(prefers-color-scheme:dark){:root{--bg:#14171a;--panel:#1c2024;--ink:#e8eaed;--muted:#9aa1ab;--line:#2c3238;--accent:#3fb59f;--accent-ink:#08201b;--bad:#f2877f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:26px;max-width:440px;width:100%}
.brand{font-weight:700;font-size:18px;margin-bottom:14px}.brand span{color:var(--accent)}
h1{font-size:19px;margin:0 0 8px}p{margin:0 0 14px;color:var(--muted)}b{color:var(--ink)}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:5px}
input[type=password]{width:100%;font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
.row{display:flex;gap:8px;margin-top:16px;justify-content:flex-end}
button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);font-weight:600}
.err{color:var(--bad);margin:10px 0 0}.fine{font-size:12.5px;margin-top:14px}
</style></head><body><div class="card"><div class="brand">Ledger<span>ly</span></div>${body}</div></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        ...noStore,
      },
    },
  );
}

const errorPage = (msg: string) => htmlPage(`<h1>Can't connect</h1><p>${esc(msg)}</p>`, 400);

function oauthError(error: string, description: string, status = 400) {
  return Response.json({ error, error_description: description }, { status, headers: noStore });
}

function redirectWith(redirectUri: string, params: Record<string, string | undefined>) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: u.toString(), ...noStore } });
}

interface AuthParams {
  client_id: string;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
}

function renderConsent(p: AuthParams, clientName: string, error?: string) {
  const host = new URL(p.redirect_uri).host;
  const hidden = (k: string, v?: string) => (v === undefined ? "" : `<input type="hidden" name="${k}" value="${esc(v)}">`);
  return htmlPage(
    `<h1>Connect <b>${esc(clientName)}</b> to Ledgerly</h1>
<p>This lets the app read and change your company's clients, orders, inventory, invoices and books. After you approve, you'll be sent back to <b>${esc(host)}</b>.</p>
<form method="post" action="/authorize">
${hidden("client_id", p.client_id)}${hidden("redirect_uri", p.redirect_uri)}${hidden("state", p.state)}${hidden("code_challenge", p.code_challenge)}
<label for="k">Workspace API key</label>
<input id="k" name="api_key" type="password" autocomplete="off" placeholder="lgk_…" required autofocus>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<div class="row"><button name="decision" value="deny" formnovalidate>Cancel</button><button class="primary" name="decision" value="approve">Approve</button></div>
</form>
<p class="fine">Only approve if you started this connection. Your administrator can revoke every connection at any time by rotating the workspace key.</p>`,
  );
}

async function loadClient(db: D1Database, clientId: string) {
  const row = await db.prepare("SELECT client_name, redirect_uris FROM oauth_clients WHERE client_id=?").bind(clientId).first<{ client_name: string | null; redirect_uris: string }>();
  return row ? { name: row.client_name || "An application", redirectUris: JSON.parse(row.redirect_uris) as string[] } : null;
}

async function cleanup(db: D1Database) {
  await db.batch([
    db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").bind(now()),
    db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").bind(now() - 86400),
  ]);
}

async function issueTokens(db: D1Database, clientId: string, orgId: string, family: string) {
  const access = randomKey("lga_");
  const refresh = randomKey("lgr_");
  await db.batch([
    db.prepare("INSERT INTO oauth_tokens (token_hash, kind, client_id, org_id, family, expires_at) VALUES (?,?,?,?,?,?)").bind(await sha256Hex(access), "access", clientId, orgId, family, now() + ACCESS_TTL),
    db.prepare("INSERT INTO oauth_tokens (token_hash, kind, client_id, org_id, family, expires_at) VALUES (?,?,?,?,?,?)").bind(await sha256Hex(refresh), "refresh", clientId, orgId, family, now() + REFRESH_TTL),
  ]);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: SCOPE };
}

// ---- routes ---------------------------------------------------------------------

export function mountOAuth(app: Hono<any>) {
  const protectedResource = (c: C) =>
    c.json({
      resource: `${originOf(c)}/mcp`,
      authorization_servers: [originOf(c)],
      bearer_methods_supported: ["header"],
      scopes_supported: [SCOPE],
      resource_name: "Ledgerly",
    });
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  app.get("/.well-known/oauth-authorization-server", (c: C) => {
    const o = originOf(c);
    return c.json({
      issuer: o,
      authorization_endpoint: `${o}/authorize`,
      token_endpoint: `${o}/token`,
      registration_endpoint: `${o}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [SCOPE],
    });
  });

  // Dynamic Client Registration (public clients)
  app.post("/register", async (c: C) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && validRedirectUri(u)))
      return oauthError("invalid_redirect_uri", "redirect_uris must be 1-10 https URLs (or http loopback URLs) without fragments");
    const name = typeof body?.client_name === "string" ? body.client_name.slice(0, 100) : "An application";
    const clientId = `lgc_${uid()}`;
    await c.env.DB.prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?,?,?,?)").bind(clientId, name, JSON.stringify(uris), now()).run();
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: now(),
        client_name: name,
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: SCOPE,
      },
      201,
      noStore,
    );
  });

  // Authorization endpoint: consent page
  app.get("/authorize", async (c: C) => {
    const q = c.req.query();
    const client = q.client_id ? await loadClient(c.env.DB, q.client_id) : null;
    if (!client) return errorPage("Unknown application.");
    if (!q.redirect_uri || !redirectAllowed(client.redirectUris, q.redirect_uri)) return errorPage("The redirect address is not registered for this application.");
    const fail = (error: string, description: string) => redirectWith(q.redirect_uri, { error, error_description: description, state: q.state });
    if (q.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
    if (!q.code_challenge || q.code_challenge_method !== "S256") return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
    if (!/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) return fail("invalid_request", "code_challenge is not a valid S256 challenge");
    if (q.resource && q.resource !== `${originOf(c)}/mcp`) return fail("invalid_target", "Unknown resource");
    return renderConsent({ client_id: q.client_id, redirect_uri: q.redirect_uri, state: q.state, code_challenge: q.code_challenge }, client.name);
  });

  // Authorization endpoint: consent submitted
  app.post("/authorize", async (c: C) => {
    const f = (await c.req.parseBody()) as Record<string, string>;
    const client = f.client_id ? await loadClient(c.env.DB, f.client_id) : null;
    if (!client) return errorPage("Unknown application.");
    if (!f.redirect_uri || !redirectAllowed(client.redirectUris, f.redirect_uri)) return errorPage("The redirect address is not registered for this application.");
    if (!/^[A-Za-z0-9_-]{43}$/.test(f.code_challenge ?? "")) return errorPage("Invalid request.");
    const p: AuthParams = { client_id: f.client_id, redirect_uri: f.redirect_uri, state: f.state || undefined, code_challenge: f.code_challenge };

    if (f.decision !== "approve") return redirectWith(p.redirect_uri, { error: "access_denied", error_description: "The user cancelled", state: p.state });

    const orgId = await authenticate(c.env.DB, (f.api_key ?? "").trim() || null);
    if (!orgId) return renderConsent(p, client.name, "That API key was not accepted.");

    const code = randomKey("lgx_");
    await c.env.DB.prepare("INSERT INTO oauth_codes (code_hash, client_id, org_id, redirect_uri, code_challenge, expires_at) VALUES (?,?,?,?,?,?)")
      .bind(await sha256Hex(code), p.client_id, orgId, p.redirect_uri, p.code_challenge, now() + CODE_TTL)
      .run();
    return redirectWith(p.redirect_uri, { code, state: p.state });
  });

  // Token endpoint
  app.post("/token", async (c: C) => {
    const f = (await c.req.parseBody().catch(() => ({}))) as Record<string, string>;
    const db = c.env.DB;
    cleanup(db).catch(() => {});

    if (f.grant_type === "authorization_code") {
      if (!f.code || !f.client_id || !f.redirect_uri || !f.code_verifier) return oauthError("invalid_request", "code, client_id, redirect_uri and code_verifier are required");
      if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(f.code_verifier)) return oauthError("invalid_grant", "Invalid code_verifier");
      // DELETE ... RETURNING makes the code single-use even under concurrent requests
      const row = await db
        .prepare("DELETE FROM oauth_codes WHERE code_hash=? RETURNING client_id, org_id, redirect_uri, code_challenge, expires_at")
        .bind(await sha256Hex(f.code))
        .first<{ client_id: string; org_id: string; redirect_uri: string; code_challenge: string; expires_at: number }>();
      if (!row || row.expires_at < now()) return oauthError("invalid_grant", "The authorization code is invalid or expired");
      if (row.client_id !== f.client_id || row.redirect_uri !== f.redirect_uri) return oauthError("invalid_grant", "Code was issued to a different client or redirect_uri");
      if ((await s256(f.code_verifier)) !== row.code_challenge) return oauthError("invalid_grant", "PKCE verification failed");
      return c.json(await issueTokens(db, row.client_id, row.org_id, uid()), 200, noStore);
    }

    if (f.grant_type === "refresh_token") {
      if (!f.refresh_token || !f.client_id) return oauthError("invalid_request", "refresh_token and client_id are required");
      const hash = await sha256Hex(f.refresh_token);
      const row = await db.prepare("SELECT client_id, org_id, family, used, expires_at FROM oauth_tokens WHERE token_hash=? AND kind='refresh'").bind(hash).first<{ client_id: string; org_id: string; family: string; used: number; expires_at: number }>();
      if (!row || row.client_id !== f.client_id || row.expires_at < now()) return oauthError("invalid_grant", "The refresh token is invalid or expired");
      if (row.used) {
        // A rotated token was presented again: assume theft and kill the whole grant.
        await db.prepare("DELETE FROM oauth_tokens WHERE family=?").bind(row.family).run();
        return oauthError("invalid_grant", "The refresh token was already used");
      }
      const claimed = await db.prepare("UPDATE oauth_tokens SET used=1 WHERE token_hash=? AND used=0").bind(hash).run();
      if (claimed.meta.changes !== 1) return oauthError("invalid_grant", "The refresh token was already used");
      return c.json(await issueTokens(db, row.client_id, row.org_id, row.family), 200, noStore);
    }

    return oauthError("unsupported_grant_type", "Supported grant types: authorization_code, refresh_token");
  });
}
