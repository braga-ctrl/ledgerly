// End-to-end smoke test. Run against a local `wrangler dev` or a deployed Worker:
//   BASE_URL=http://127.0.0.1:8787 ADMIN_TOKEN=... node scripts/smoke-test.mjs
import { createHash, randomBytes } from "node:crypto";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8787";
const ADMIN = process.env.ADMIN_TOKEN || "test-admin-token";

let passed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) passed++;
  else failures.push(`${name}${detail ? " -> " + detail : ""}`);
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

async function http(method, path, { key, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

let rpcId = 0;
const rpc = (key, method, params) => http("POST", "/mcp", { key, body: { jsonrpc: "2.0", id: ++rpcId, method, params } });
async function tool(key, name, args = {}) {
  const r = await rpc(key, "tools/call", { name, arguments: args });
  const res = r.json?.result;
  return { isError: !!res?.isError, data: res?.structuredContent, text: res?.content?.[0]?.text, rpcError: r.json?.error };
}
const ok = async (key, name, args) => {
  const r = await tool(key, name, args);
  if (r.isError || r.rpcError) throw new Error(`${name} failed: ${r.text ?? JSON.stringify(r.rpcError)}`);
  return r.data;
};

// ------------------------------------------------------------------ auth & admin
let r = await http("POST", "/admin/orgs", { body: { name: "X" } });
eq("admin without token is 401", r.status, 401);
r = await http("POST", "/admin/orgs", { key: "wrong", body: { name: "X" } });
eq("admin with wrong token is 401", r.status, 401);
r = await http("POST", "/admin/orgs", { key: ADMIN, body: {} });
eq("admin create without name is 400", r.status, 400);

r = await http("POST", "/admin/orgs", { key: ADMIN, body: { name: "Northwind Trading" } });
eq("org created", r.status, 201);
let KEY = r.json.api_key;
const ORG_ID = r.json.org_id;
check("api key has prefix", KEY?.startsWith("lgk_"));

r = await http("POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "ping" } });
eq("mcp without key is 401", r.status, 401);
check("401 carries WWW-Authenticate", (r.headers.get("www-authenticate") || "").startsWith("Bearer"));
r = await http("GET", "/api/tools", { key: "lgk_nope" });
eq("bad tenant key is 401", r.status, 401);
r = await http("GET", "/health");
eq("health open", r.status, 200);
r = await fetch(BASE + "/");
check("web UI served at /", r.status === 200 && (await r.text()).includes("Ledgerly"));
r = await fetch(BASE + "/privacy");
check("privacy policy page served at /privacy", r.status === 200 && (await r.text()).includes("privacy policy"));

// ------------------------------------------------------------------ MCP protocol
r = await rpc(KEY, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
eq("initialize echoes protocol", r.json.result.protocolVersion, "2025-06-18");
eq("server name", r.json.result.serverInfo.name, "ledgerly");
r = await http("POST", "/mcp", { key: KEY, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
eq("notification gets 202", r.status, 202);
r = await rpc(KEY, "tools/list", {});
const toolNames = r.json.result.tools.map((t) => t.name);
check("tools/list has the full set", toolNames.length >= 25, `only ${toolNames.length}`);
check("every tool has an object schema", r.json.result.tools.every((t) => t.inputSchema?.type === "object"));
check("every tool has a title and read-only/destructive annotations (directory requirement)",
  r.json.result.tools.every((t) => t.title && typeof t.annotations?.readOnlyHint === "boolean" && typeof t.annotations?.destructiveHint === "boolean"));
const ann = Object.fromEntries(r.json.result.tools.map((t) => [t.name, t.annotations]));
check("read tools are marked read-only and non-destructive", ann.get_dashboard.readOnlyHint === true && ann.get_dashboard.destructiveHint === false);
check("void_invoice and cancel_order are marked destructive", ann.void_invoice.destructiveHint === true && ann.cancel_order.destructiveHint === true);
check("ordinary writes are not read-only", ann.create_client.readOnlyHint === false && ann.record_payment.readOnlyHint === false);
r = await rpc(KEY, "tools/call", { name: "nope", arguments: {} });
eq("unknown tool is JSON-RPC error", r.json.error?.code, -32602);
r = await rpc(KEY, "no/such/method", {});
eq("unknown method", r.json.error?.code, -32601);
r = await http("GET", "/mcp", { key: KEY });
eq("GET /mcp is 405", r.status, 405);

// ------------------------------------------------------------------ onboarding gate
await ok(KEY, "record_owner_investment", { amount: 10000, memo: "Opening capital" });
await ok(KEY, "add_product", { sku: "SKU-A", name: "Widget A", unit_price: 50, reorder_level: 5 });
await ok(KEY, "add_product", { sku: "SKU-B", name: "Widget B", unit_price: 20, reorder_level: 10 });
let p = await ok(KEY, "receive_stock", { sku: "SKU-A", qty: 20, unit_cost: 30 });
eq("stock received", p.stock_qty, 20);
eq("average cost set", p.unit_cost, 30);
p = await ok(KEY, "receive_stock", { sku: "SKU-A", qty: 20, unit_cost: 40, date: "2026-11-01" });
eq("weighted average cost", p.unit_cost, 35); // (20*30 + 20*40)/40
eq("stock after 2nd receipt", p.stock_qty, 40);
// undo that second receipt's effect on the numbers below by selling through it is complicated, so use a fresh product
await ok(KEY, "add_product", { sku: "SKU-C", name: "Widget C", unit_price: 50, unit_cost: 0, reorder_level: 5 });
await ok(KEY, "receive_stock", { sku: "SKU-C", qty: 20, unit_cost: 30 });

let c = await ok(KEY, "create_client", { name: "Acme Industrial", email: "ap@acme.example" });
eq("new client pending", c.status, "documents_pending");
eq("three required documents", c.documents.length, 3);
let t = await tool(KEY, "create_order", { client: "Acme Industrial", items: [{ sku: "SKU-C", qty: 1 }] });
check("order blocked for un-onboarded client", t.isError && /onboarding|approved/i.test(t.text), t.text);
t = await tool(KEY, "create_invoice", { client: "Acme Industrial", items: [{ description: "x", qty: 1, unit_price: 1 }] });
check("invoice blocked for un-onboarded client", t.isError, t.text);
t = await tool(KEY, "create_client", { name: "acme industrial" });
check("duplicate client name rejected", t.isError && /already exists/.test(t.text), t.text);

c = await ok(KEY, "update_client_document", { client: "Acme Industrial", doc_type: "business_registration", status: "approved" });
eq("still pending after one approval", c.status, "documents_pending");
await ok(KEY, "update_client_document", { client: c.id, doc_type: "tax_id", status: "received" });
c = await ok(KEY, "update_client_document", { client: c.id, doc_type: "authorized_signatory", status: "received" });
eq("under review once everything is received", c.status, "under_review");
c = await ok(KEY, "update_client_document", { client: c.id, doc_type: "tax_id", status: "rejected", note: "Blurry scan" });
eq("rejected doc sends client back to pending", c.status, "documents_pending");
await ok(KEY, "update_client_document", { client: c.id, doc_type: "tax_id", status: "approved" });
c = await ok(KEY, "update_client_document", { client: c.id, doc_type: "authorized_signatory", status: "approved" });
eq("client approved when all docs approved", c.status, "approved");

// ------------------------------------------------------------------ order -> fulfil -> invoice -> payment
let o = await ok(KEY, "create_order", { client: "Acme Industrial", items: [{ sku: "SKU-C", qty: 8 }] });
eq("order total", o.total, 400);
t = await tool(KEY, "create_order", { client: "Acme Industrial", items: [{ sku: "SKU-C", qty: 15 }] });
check("reservation blocks over-commit", t.isError && /Not enough stock/.test(t.text), t.text);
t = await tool(KEY, "create_order", { client: "Acme Industrial", items: [{ sku: "SKU-C", qty: 0 }] });
check("qty 0 rejected", t.isError, t.text);
t = await tool(KEY, "create_order", { client: "Acme Industrial", items: [{ sku: "NOPE", qty: 1 }] });
check("unknown SKU rejected", t.isError && /not found/.test(t.text), t.text);

let f = await ok(KEY, "fulfill_order", { order_id: o.order_id });
eq("order fulfilled", f.order.status, "fulfilled");
eq("first invoice number", f.invoice.number, "INV-00001");
eq("invoice total", f.invoice.total, 400);
t = await tool(KEY, "fulfill_order", { order_id: o.order_id });
check("cannot fulfil twice", t.isError, t.text);
let prods = (await ok(KEY, "list_products", { search: "SKU-C" })).products;
eq("stock reduced by sale", prods[0].stock_qty, 12);

let inv = await ok(KEY, "record_payment", { invoice: "INV-00001", amount: 150, method: "bank transfer" });
eq("partial payment status", inv.status, "partial");
eq("partial balance", inv.balance, 250);
t = await tool(KEY, "record_payment", { invoice: "INV-00001", amount: 300 });
check("overpayment rejected", t.isError && /exceeds/.test(t.text), t.text);
inv = await ok(KEY, "record_payment", { invoice: f.invoice.invoice_id, amount: 250 });
eq("fully paid", inv.status, "paid");
eq("two payments on record", inv.payments.length, 2);
t = await tool(KEY, "record_payment", { invoice: "INV-00001", amount: 1 });
check("paying a paid invoice rejected", t.isError, t.text);

// ------------------------------------------------------------------ services invoice, aging, void, expenses
let s = await ok(KEY, "create_invoice", { client: "Acme Industrial", items: [{ description: "Consulting", qty: 1, unit_price: 1000 }], issue_date: "2026-09-01", terms_days: 30 });
eq("second invoice number", s.number, "INV-00002");
eq("due date from terms", s.due_date, "2026-10-01");
check("flagged overdue", s.overdue === true && s.days_overdue > 30, JSON.stringify(s));
let aging = await ok(KEY, "get_ar_aging");
eq("aging total", aging.totals.total, 1000);
eq("aging bucket 31-60", aging.totals.days_31_60, 1000);
let od = (await ok(KEY, "list_invoices", { overdue_only: true })).invoices;
eq("overdue list", od.map((x) => x.number), ["INV-00002"]);

await ok(KEY, "record_expense", { description: "Office rent", amount: 200 });
t = await tool(KEY, "record_expense", { description: "bad", amount: 5, account_code: "1000" });
check("expense to non-expense account rejected", t.isError, t.text);
await ok(KEY, "record_expense", { description: "Courier (unpaid)", amount: 80, paid_from: "payable" });
t = await tool(KEY, "pay_supplier", { amount: 500 });
check("cannot pay more than owed", t.isError, t.text);
const ps = await ok(KEY, "pay_supplier", { amount: 80 });
eq("payable cleared", ps.payable_remaining, 0);

// ------------------------------------------------------------------ books must balance and match
const tb = await ok(KEY, "get_trial_balance");
check("trial balance balances", tb.balanced === true, `${tb.total_debit} vs ${tb.total_credit}`);
const bal = Object.fromEntries(tb.lines.map((l) => [l.account.split(" ")[0], l.debit - l.credit]));
// Cash: +10000 capital -(20*30) -(20*40) stock -200 -80 rent/courier... then +400 payments -80 supplier
//   = 10000 - 600 - 800 - 200 - 600... computed explicitly below
eq("cash", Math.round(bal["1000"] * 100) / 100, 10000 - 600 - 800 - 600 + 400 - 200 - 80);
eq("receivables", bal["1100"], 1000);
eq("inventory = SKU-A 40 x 35 + SKU-C 12 x 30", bal["1200"], 1400 + 360);
eq("payables settled", bal["2000"], 0);
eq("equity", bal["3000"], -10000);
eq("revenue", bal["4000"], -1400);
eq("cogs", bal["5000"], 240);
eq("opex", bal["6000"], 280);

const pl = await ok(KEY, "get_profit_and_loss", { from: "2026-01-01", to: "2026-12-31" });
eq("P&L revenue", pl.total_revenue, 1400);
eq("P&L expenses", pl.total_expenses, 520);
eq("P&L net income", pl.net_income, 880);
eq("P&L gross profit", pl.gross_profit, 1160);

const j = await ok(KEY, "get_journal", { limit: 100 });
check("every journal entry balances", j.entries.every((e) => {
  const d = e.lines.reduce((a, l) => a + Math.round(l.debit * 100), 0);
  const cr = e.lines.reduce((a, l) => a + Math.round(l.credit * 100), 0);
  return d === cr && d > 0;
}));

// void rules
t = await tool(KEY, "void_invoice", { invoice: "INV-00001" });
check("cannot void an order invoice", t.isError, t.text);
const v = await ok(KEY, "void_invoice", { invoice: "INV-00002" });
eq("voided", v.status, "void");
eq("void balance is zero", v.balance, 0);
eq("AR zero after void", (await ok(KEY, "get_dashboard")).accounts_receivable, 0);
check("trial balance still balances after void", (await ok(KEY, "get_trial_balance")).balanced === true);

// ------------------------------------------------------------------ dashboard / low stock / cancel
const dash = await ok(KEY, "get_dashboard");
eq("dashboard low stock", dash.low_stock_products, 1); // SKU-B: 0 on hand, reorder 10
eq("dashboard clients", dash.clients_by_status, { approved: 1 });
const low = (await ok(KEY, "get_low_stock")).products;
eq("low stock list", low.map((x) => x.sku), ["SKU-B"]);
const o2 = await ok(KEY, "create_order", { client: "Acme Industrial", items: [{ sku: "SKU-C", qty: 12 }] });
t = await tool(KEY, "create_order", { client: "Acme Industrial", items: [{ sku: "SKU-C", qty: 1 }] });
check("reserved stock counted", t.isError, t.text);
await ok(KEY, "cancel_order", { order_id: o2.order_id });
await ok(KEY, "create_order", { client: "Acme Industrial", items: [{ sku: "SKU-C", qty: 1 }] }); // stock released

// ------------------------------------------------------------------ REST mirrors MCP
r = await http("POST", "/api/tools/list_clients", { key: KEY, body: {} });
eq("REST tool call", r.json.clients.length, 1);
r = await http("POST", "/api/tools/get_client", { key: KEY, body: { client: "nobody" } });
eq("REST 404 for missing client", r.status, 404);
r = await http("POST", "/api/tools/create_client", { key: KEY, body: {} });
eq("REST 400 for bad input", r.status, 400);

// ------------------------------------------------------------------ tenant isolation
r = await http("POST", "/admin/orgs", { key: ADMIN, body: { name: "Other Co" } });
const KEY2 = r.json.api_key;
eq("other tenant sees no clients", (await ok(KEY2, "list_clients")).clients.length, 0);
eq("other tenant sees no invoices", (await ok(KEY2, "list_invoices")).invoices.length, 0);
t = await tool(KEY2, "get_invoice", { invoice: "INV-00001" });
check("other tenant cannot read my invoice", t.isError && /not found/.test(t.text), t.text);
t = await tool(KEY2, "get_client", { client: c.id });
check("other tenant cannot read my client by id", t.isError, t.text);
t = await tool(KEY2, "get_order", { order_id: o.order_id });
check("other tenant cannot read my order", t.isError, t.text);
eq("other tenant starts clean", (await ok(KEY2, "get_dashboard")).cash, 0);
t = await tool(KEY2, "receive_stock", { sku: "SKU-A", qty: 1, unit_cost: 1 });
check("other tenant cannot touch my products", t.isError, t.text);
r = await http("POST", `/admin/orgs/${(await http("POST", "/admin/orgs", { key: ADMIN, body: { name: "Third" } })).json.org_id}/keys`, { key: ADMIN, body: { label: "ci" } });
eq("extra key issued", r.status, 201);

// ------------------------------------------------------------------ OAuth 2.0 (what Claude's "Connect" button uses)
const CB = "https://claude.ai/api/mcp/auth_callback";
const manual = (path, init = {}) => fetch(BASE + path, { redirect: "manual", ...init });
const formPost = (path, obj) =>
  manual(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(obj).toString() });
const b64u = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const pkce = () => {
  const verifier = b64u(randomBytes(32));
  return { verifier, challenge: b64u(createHash("sha256").update(verifier).digest()) };
};

r = await http("GET", "/.well-known/oauth-protected-resource");
eq("resource metadata: resource", r.json.resource, `${BASE}/mcp`);
eq("resource metadata: auth server", r.json.authorization_servers, [BASE]);
r = await http("GET", "/.well-known/oauth-authorization-server");
eq("AS metadata: PKCE S256 only", r.json.code_challenge_methods_supported, ["S256"]);
check("AS metadata: endpoints", r.json.registration_endpoint === `${BASE}/register` && r.json.token_endpoint === `${BASE}/token` && r.json.authorization_endpoint === `${BASE}/authorize`);
r = await http("POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "ping" } });
check("401 points at resource metadata", (r.headers.get("www-authenticate") || "").includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`), r.headers.get("www-authenticate"));

r = await http("POST", "/register", { body: { redirect_uris: ["http://evil.example/cb"] } });
eq("registration rejects non-https, non-loopback redirect", r.json?.error, "invalid_redirect_uri");
r = await http("POST", "/register", { body: { redirect_uris: [CB], client_name: "Claude" } });
eq("client registered", r.status, 201);
const CID = r.json.client_id;
eq("public client", r.json.token_endpoint_auth_method, "none");

const authUrl = (o = {}) => {
  const p = pkce();
  const q = new URLSearchParams({ response_type: "code", client_id: CID, redirect_uri: CB, state: "st8", code_challenge: p.challenge, code_challenge_method: "S256", ...o });
  return { url: `/authorize?${q}`, ...p };
};
let a = authUrl();
r = await manual(a.url);
const consent = await r.text();
check("consent page shown with redirect host", r.status === 200 && consent.includes("claude.ai") && consent.includes("Approve"));
check("consent page blocks framing", (r.headers.get("x-frame-options") || "") === "DENY");
r = await manual(authUrl({ redirect_uri: "https://evil.example/cb" }).url);
eq("unregistered redirect is an error page, not a redirect", r.status, 400);
r = await manual(authUrl({ client_id: "lgc_unknown" }).url);
eq("unknown client rejected", r.status, 400);
r = await manual(`/authorize?response_type=code&client_id=${CID}&redirect_uri=${encodeURIComponent(CB)}&state=s`);
check("missing PKCE is bounced back with an error", r.status === 302 && r.headers.get("location").includes("error=invalid_request") && r.headers.get("location").includes("state=s"));

const approve = async (pk, apiKey = KEY, decision = "approve") =>
  formPost("/authorize", { client_id: CID, redirect_uri: CB, state: "st8", code_challenge: pk.challenge, api_key: apiKey, decision });
r = await approve(a, "lgk_wrong");
check("bad workspace key re-shows consent", r.status === 200 && (await r.text()).includes("not accepted"));
r = await approve(a, KEY, "deny");
check("deny returns access_denied with state", r.status === 302 && r.headers.get("location").includes("error=access_denied") && r.headers.get("location").includes("state=st8"));

const getCode = async (pk) => {
  const res = await approve(pk);
  const loc = new URL(res.headers.get("location"));
  return { code: loc.searchParams.get("code"), state: loc.searchParams.get("state"), status: res.status };
};
let g = await getCode(a);
check("approve redirects with code and state", g.status === 302 && g.code?.startsWith("lgx_") && g.state === "st8");
const tok = (extra) => formPost("/token", { client_id: CID, ...extra }).then(async (res) => ({ status: res.status, json: await res.json() }));

let t1 = await tok({ grant_type: "authorization_code", code: g.code, redirect_uri: CB, code_verifier: pkce().verifier });
check("wrong PKCE verifier rejected", t1.status === 400 && t1.json.error === "invalid_grant", JSON.stringify(t1));
t1 = await tok({ grant_type: "authorization_code", code: g.code, redirect_uri: CB, code_verifier: a.verifier });
eq("code is single-use (consumed by the failed attempt)", t1.json.error, "invalid_grant");

a = authUrl(); g = await getCode(a);
t1 = await tok({ grant_type: "authorization_code", code: g.code, redirect_uri: "https://claude.ai/other", code_verifier: a.verifier });
eq("redirect_uri mismatch rejected", t1.json.error, "invalid_grant");

a = authUrl(); g = await getCode(a);
t1 = await tok({ grant_type: "authorization_code", code: g.code, redirect_uri: CB, code_verifier: a.verifier });
check("tokens issued", t1.status === 200 && t1.json.access_token?.startsWith("lga_") && t1.json.refresh_token?.startsWith("lgr_") && t1.json.token_type === "Bearer", JSON.stringify(t1));
const replay = await tok({ grant_type: "authorization_code", code: g.code, redirect_uri: CB, code_verifier: a.verifier });
eq("code replay rejected", replay.json.error, "invalid_grant");
const other = await formPost("/token", { grant_type: "password" });
eq("unsupported grant type", (await other.json()).error, "unsupported_grant_type");

// the OAuth access token reaches the same workspace data as the API key
const viaOauth = await tool(t1.json.access_token, "get_dashboard");
check("access token works on /mcp", !viaOauth.isError && viaOauth.data?.currency === "USD", JSON.stringify(viaOauth));
eq("same workspace as the API key", viaOauth.data.cash, (await ok(KEY, "get_dashboard")).cash);
r = await http("POST", "/api/tools/list_clients", { key: t1.json.access_token, body: {} });
eq("access token works on REST too", r.status, 200);
r = await http("POST", "/mcp", { key: "lga_forged", body: { jsonrpc: "2.0", id: 1, method: "ping" } });
eq("forged access token rejected", r.status, 401);

// refresh rotation + reuse detection
const t2 = await tok({ grant_type: "refresh_token", refresh_token: t1.json.refresh_token });
check("refresh issues a new pair", t2.status === 200 && t2.json.access_token !== t1.json.access_token && t2.json.refresh_token !== t1.json.refresh_token, JSON.stringify(t2));
check("new access token works", !(await tool(t2.json.access_token, "get_dashboard")).isError);
const reuse = await tok({ grant_type: "refresh_token", refresh_token: t1.json.refresh_token });
eq("rotated refresh token cannot be reused", reuse.json.error, "invalid_grant");
r = await http("POST", "/mcp", { key: t2.json.access_token, body: { jsonrpc: "2.0", id: 1, method: "ping" } });
eq("reuse revokes the whole grant", r.status, 401);
const wrongClient = await tok({ grant_type: "refresh_token", refresh_token: t2.json.refresh_token, client_id: "lgc_other" });
eq("refresh bound to its client", wrongClient.json.error, "invalid_grant");

// Claude Code uses a loopback redirect on a random port
r = await http("POST", "/register", { body: { redirect_uris: ["http://localhost/callback"], client_name: "Claude Code" } });
const CID2 = r.json.client_id;
const lb = pkce();
r = await manual(`/authorize?${new URLSearchParams({ response_type: "code", client_id: CID2, redirect_uri: "http://localhost:3118/callback", code_challenge: lb.challenge, code_challenge_method: "S256" })}`);
eq("loopback redirect accepted on any port", r.status, 200);

// ------------------------------------------------------------------ key rotation revokes everything
a = authUrl(); g = await getCode(a);
const live = await tok({ grant_type: "authorization_code", code: g.code, redirect_uri: CB, code_verifier: a.verifier });
check("fresh OAuth grant works before rotation", !(await tool(live.json.access_token, "get_dashboard")).isError);
const beforeCash = (await ok(KEY, "get_dashboard")).cash;
r = await http("POST", `/admin/orgs/${ORG_ID}/rotate-keys`, { body: {} });
eq("rotate-keys requires the admin token", r.status, 401);
r = await http("POST", "/admin/orgs/does-not-exist/rotate-keys", { key: ADMIN, body: {} });
eq("rotate-keys on unknown workspace is 404", r.status, 404);
r = await http("POST", `/admin/orgs/${ORG_ID}/rotate-keys`, { key: ADMIN, body: {} });
eq("rotate-keys succeeds", r.status, 200);
const NEWKEY = r.json.api_key;
r = await http("POST", "/mcp", { key: KEY, body: { jsonrpc: "2.0", id: 1, method: "ping" } });
eq("old API key revoked", r.status, 401);
r = await http("POST", "/mcp", { key: live.json.access_token, body: { jsonrpc: "2.0", id: 1, method: "ping" } });
eq("OAuth access token revoked", r.status, 401);
const dead = await tok({ grant_type: "refresh_token", refresh_token: live.json.refresh_token });
eq("OAuth refresh token revoked", dead.json.error, "invalid_grant");
KEY = NEWKEY;
eq("new key sees the same data", (await ok(KEY, "get_dashboard")).cash, beforeCash);

// ------------------------------------------------------------------ Sprint 1: ledger correctness and trust
// Runs in its own workspace so the exact-figure checks above stay untouched.
{
  r = await http("POST", "/admin/orgs", { key: ADMIN, body: { name: "Sprint One Co" } });
  const S = r.json.api_key;
  const dashS = () => ok(S, "get_dashboard");
  const net = async (code) => {
    const l = (await ok(S, "get_trial_balance")).lines.find((x) => x.account.startsWith(code + " "));
    return Math.round((l.debit - l.credit) * 100) / 100;
  };
  const balanced = async (label) => check(`${label}: trial balance still balances`, (await ok(S, "get_trial_balance")).balanced === true);
  const approve = async (name, email) => {
    await ok(S, "create_client", { name, email });
    for (const dt of ["business_registration", "tax_id", "authorized_signatory"]) await ok(S, "update_client_document", { client: name, doc_type: dt, status: "approved" });
  };
  const entryByMemo = async (re, type) => (await ok(S, "get_journal", { limit: 100 })).entries.find((e) => re.test(e.memo) && (!type || e.type === type));
  let x, d, pr;

  // ---- the new tools are annotated correctly
  const toolList = (await rpc(S, "tools/list", {})).json.result.tools;
  const anno = Object.fromEntries(toolList.map((t) => [t.name, t.annotations]));
  check("reverse_journal_entry and issue_credit_note are marked destructive", anno.reverse_journal_entry?.destructiveHint === true && anno.issue_credit_note?.destructiveHint === true);
  check("get_audit_log and get_settings are read-only", anno.get_audit_log?.readOnlyHint === true && anno.get_settings?.readOnlyHint === true);
  check("edit tools are writes, not destructive", ["update_product", "update_client", "update_settings"].every((n) => anno[n]?.readOnlyHint === false && anno[n]?.destructiveHint === false));

  // ---- P0-2 reorder level is asked for
  x = await tool(S, "add_product", { sku: "W1", name: "Widget", unit_price: 10 });
  check("P0-2 reorder level is required when adding a product", x.isError && /reorder_level/.test(x.text), x.text);
  x = await tool(S, "add_product", { sku: "W1", name: "Widget", unit_price: 10, reorder_level: -1 });
  check("P0-2 negative reorder level rejected", x.isError, x.text);
  await ok(S, "add_product", { sku: "W1", name: "Widget", unit_price: 10, reorder_level: 0 });
  d = await dashS();
  eq("P0-2 dashboard counts products with no reorder level", d.products_without_reorder_level, 1);
  check("P0-2 dashboard warns about it", d.warnings.some((w) => /reorder level/.test(w)), JSON.stringify(d.warnings));
  pr = await ok(S, "update_product", { sku: "W1", reorder_level: 20 });
  eq("P0-2 reorder level can be set afterwards", pr.reorder_level, 20);
  d = await dashS();
  eq("P0-2 count drops once a level is set", d.products_without_reorder_level, 0);
  eq("P0-2 low-stock count follows the new level (0 on hand <= 20)", d.low_stock_products, 1);

  // ---- P0-1 cash policy
  eq("P0-1 default policy is warn", (await ok(S, "get_settings")).cash_policy, "warn");
  x = await ok(S, "receive_stock", { sku: "W1", qty: 100, unit_cost: 6 });
  eq("P0-1 warn: the cash receipt still goes through", x.stock_qty, 100);
  check("P0-1 warn: the caller is told, and offered the fixes", x.warnings?.length === 1 && /record_owner_investment/.test(x.warnings[0]) && /on credit/.test(x.warnings[0]), JSON.stringify(x.warnings));
  d = await dashS();
  eq("P0-1 cash is negative after an unfunded cash receipt", d.cash, -600);
  check("P0-1 dashboard shows a visible negative-cash warning", d.warnings.some((w) => /negative/i.test(w)), JSON.stringify(d.warnings));

  x = await tool(S, "update_settings", { cash_policy: "sometimes" });
  check("P0-1 unknown policy rejected", x.isError, x.text);
  x = await tool(S, "update_settings", {});
  check("P0-1 update_settings needs something to change", x.isError, x.text);
  eq("P0-1 policy set to block", (await ok(S, "update_settings", { cash_policy: "block" })).cash_policy, "block");
  x = await tool(S, "receive_stock", { sku: "W1", qty: 10, unit_cost: 6 });
  check("P0-1 block: cash receipt refused with the options named", x.isError && /cash policy/i.test(x.text) && /record_owner_investment/.test(x.text) && /on credit/.test(x.text), x.text);
  eq("P0-1 block: nothing was recorded (stock unchanged)", (await ok(S, "list_products", { search: "W1" })).products[0].stock_qty, 100);
  eq("P0-1 block: nothing was recorded (cash unchanged)", (await dashS()).cash, -600);
  x = await ok(S, "receive_stock", { sku: "W1", qty: 10, unit_cost: 6, on_credit: true });
  eq("P0-1 block: receiving on credit is still allowed", x.stock_qty, 110);
  await ok(S, "record_owner_investment", { amount: 600, memo: "Cover opening stock" });
  eq("P0-1 owner funding brings cash back to zero", (await dashS()).cash, 0);
  x = await tool(S, "pay_supplier", { amount: 60 });
  check("P0-1 block: supplier payment with no cash refused", x.isError && /cash policy/i.test(x.text), x.text);
  x = await tool(S, "record_expense", { description: "Courier", amount: 5 });
  check("P0-1 block: cash expense with no cash refused and payable offered", x.isError && /payable/.test(x.text), x.text);
  await ok(S, "record_expense", { description: "Courier (unpaid)", amount: 5, paid_from: "payable" });
  await ok(S, "record_owner_investment", { amount: 100 });
  x = await ok(S, "record_expense", { description: "Courier", amount: 5 });
  check("P0-1 block: an affordable cash expense goes through without warnings", x.recorded === true && !x.warnings, JSON.stringify(x));
  eq("P0-1 cash after the expense", (await dashS()).cash, 95);
  const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => tool(S, "record_expense", { description: `Burst ${i}`, amount: 30 })));
  const burstOk = burst.filter((b) => !b.isError).length;
  const cashAfterBurst = (await dashS()).cash;
  check("P0-1 block: concurrent payments cannot overdraw cash", cashAfterBurst >= 0 && burstOk <= 3 && Math.round((95 - burstOk * 30) * 100) / 100 === cashAfterBurst, `${burstOk} succeeded, cash ${cashAfterBurst}`);
  await balanced("P0-1 after the burst");
  await ok(S, "update_settings", { cash_policy: "allow" });
  x = await ok(S, "record_expense", { description: "Big unplanned spend", amount: 5000 });
  check("P0-1 allow: no warning and no block", x.recorded === true && !x.warnings, JSON.stringify(x));
  check("P0-1 allow: cash can go negative", (await dashS()).cash < 0);
  await ok(S, "record_owner_investment", { amount: 10000, memo: "Top up" });
  await ok(S, "update_settings", { cash_policy: "warn" });
  const polAudit = (await ok(S, "get_audit_log", { entity_type: "settings" })).entries;
  check("P0-1 every policy change is in the audit log, newest first", polAudit.length === 3 && polAudit[0].detail.cash_policy.to === "warn" && polAudit[2].detail.cash_policy.from === "warn" && polAudit[2].detail.cash_policy.to === "block", JSON.stringify(polAudit));

  // ---- P0-3 edit products and clients
  await ok(S, "add_product", { sku: "E1", name: "Edit me", unit_price: 10, reorder_level: 2 });
  await ok(S, "receive_stock", { sku: "E1", qty: 10, unit_cost: 4, on_credit: true });
  await approve("Acme", "ap@acme.example");
  const ordA = await ok(S, "create_order", { client: "Acme", items: [{ sku: "E1", qty: 2 }] });
  const ordB = await ok(S, "create_order", { client: "Acme", items: [{ sku: "E1", qty: 1 }] });
  const fA = await ok(S, "fulfill_order", { order_id: ordA.order_id });
  eq("P0-3 invoice made at the old price", fA.invoice.total, 20);
  pr = await ok(S, "update_product", { sku: "E1", name: "Edited", unit_price: 15 });
  eq("P0-3 price edit reported", pr.changes.unit_price, { from: 10, to: 15 });
  eq("P0-3 name edit applied", pr.name, "Edited");
  eq("P0-3 existing invoice keeps its price", (await ok(S, "get_invoice", { invoice: fA.invoice.number })).total, 20);
  eq("P0-3 existing order keeps its price", (await ok(S, "get_order", { order_id: ordB.order_id })).total, 10);
  eq("P0-3 new order uses the new price", (await ok(S, "create_order", { client: "Acme", items: [{ sku: "E1", qty: 1 }] })).total, 15);
  const e1Cost = (await ok(S, "list_products", { search: "E1" })).products[0];
  eq("P0-3 cost untouched by an edit", e1Cost.unit_cost, 4);
  x = await tool(S, "update_product", { sku: "E1", unit_cost: 1 });
  check("P0-3 cost cannot be edited (only through receipts)", x.isError && /receive_stock/.test(x.text), x.text);
  x = await tool(S, "update_product", { sku: "E1", stock_qty: 99 });
  check("P0-3 stock cannot be edited", x.isError, x.text);
  x = await tool(S, "update_product", { sku: "E1" });
  check("P0-3 an edit with nothing in it is rejected", x.isError, x.text);
  x = await tool(S, "update_product", { sku: "NOPE", name: "x" });
  check("P0-3 unknown product is a clean error", x.isError && /not found/.test(x.text), x.text);
  x = await tool(S, "update_product", { sku: "E1", unit_price: -1 });
  check("P0-3 negative price rejected", x.isError, x.text);
  const auditBefore = (await ok(S, "get_audit_log", { entity_type: "product" })).entries.length;
  pr = await ok(S, "update_product", { sku: "E1", unit_price: 15 });
  eq("P0-3 re-saving the same values changes nothing", pr.changes, {});
  eq("P0-3 ...and writes no audit row", (await ok(S, "get_audit_log", { entity_type: "product" })).entries.length, auditBefore);
  const prodAudit = (await ok(S, "get_audit_log", { entity_type: "product" })).entries;
  check("P0-3 product edits are in the audit trail with before and after", prodAudit.some((e) => e.action === "update" && e.detail.sku === "E1" && e.detail.unit_price?.from === 10 && e.detail.unit_price?.to === 15 && e.detail.name?.to === "Edited"), JSON.stringify(prodAudit));

  await ok(S, "create_client", { name: "Edit Me Ltd", email: "old@x.example" });
  await ok(S, "create_client", { name: "Beta Co" });
  x = await ok(S, "update_client", { client: "Edit Me Ltd", email: "new@x.example" });
  eq("P0-3 client email edited", [x.email, x.changes.email], ["new@x.example", { from: "old@x.example", to: "new@x.example" }]);
  x = await ok(S, "update_client", { client: "Edit Me Ltd", name: "Edited Ltd" });
  eq("P0-3 client renamed", x.name, "Edited Ltd");
  x = await tool(S, "update_client", { client: "Edited Ltd", name: "beta co" });
  check("P0-3 rename onto an existing client refused", x.isError && /already exists/.test(x.text), x.text);
  x = await tool(S, "update_client", { client: "Edited Ltd", status: "approved" });
  check("P0-3 onboarding status cannot be edited by hand", x.isError && /update_client_document/.test(x.text), x.text);
  x = await ok(S, "update_client", { client: "Edited Ltd", email: "" });
  eq("P0-3 empty email clears it", x.email, null);
  x = await tool(S, "update_client", { client: "Edited Ltd" });
  check("P0-3 client edit with nothing in it rejected", x.isError, x.text);
  const clientAudit = (await ok(S, "get_audit_log", { entity_type: "client" })).entries;
  check("P0-3 client edits are in the audit trail", clientAudit.length === 3 && clientAudit.some((e) => e.detail.name?.from === "Edit Me Ltd" && e.detail.name?.to === "Edited Ltd"), JSON.stringify(clientAudit));
  x = await tool(KEY2, "update_product", { sku: "E1", unit_price: 1 });
  check("P0-3 other tenant cannot edit my product", x.isError && /not found/.test(x.text), x.text);
  x = await tool(KEY2, "update_client", { client: "Acme", name: "Hijacked" });
  check("P0-3 other tenant cannot edit my client", x.isError, x.text);
  eq("P0-3 other tenant sees none of my audit log", (await ok(KEY2, "get_audit_log")).entries.length, 0);

  // ---- P0-4 reversing entries
  await ok(S, "record_owner_investment", { amount: 250, memo: "Test capital" });
  const orig = await entryByMemo(/Test capital/);
  check("P0-4 journal entries expose their id", typeof orig?.entry_id === "string" && orig.entry_id.length > 10, JSON.stringify(orig));
  const cashPre = (await dashS()).cash;
  x = await tool(S, "reverse_journal_entry", { entry_id: orig.entry_id });
  check("P0-4 a reason is required", x.isError && /reason/.test(x.text), x.text);
  x = await tool(S, "reverse_journal_entry", { entry_id: "no-such-entry", reason: "x" });
  check("P0-4 unknown entry is a clean error", x.isError && /not found/.test(x.text), x.text);
  x = await tool(KEY2, "reverse_journal_entry", { entry_id: orig.entry_id, reason: "x" });
  check("P0-4 other tenant cannot reverse my entry", x.isError && /not found/.test(x.text), x.text);
  const rev = await ok(S, "reverse_journal_entry", { entry_id: orig.entry_id, reason: "Entered twice" });
  eq("P0-4 reversal mirrors the original with sides swapped", rev.lines, [{ account: "1000 Cash and Bank", debit: 0, credit: 250 }, { account: "3000 Owner's Equity", debit: 250, credit: 0 }]);
  eq("P0-4 cash is back where it was", (await dashS()).cash, cashPre - 250);
  const jAfter = (await ok(S, "get_journal", { limit: 100 })).entries;
  const origAfter = jAfter.find((e) => e.entry_id === orig.entry_id);
  const revAfter = jAfter.find((e) => e.entry_id === rev.reversal_entry_id);
  check("P0-4 the original is still there, unchanged, and says it was reversed", origAfter && origAfter.reversed_by === rev.reversal_entry_id && JSON.stringify(origAfter.lines) === JSON.stringify(orig.lines), JSON.stringify(origAfter));
  check("P0-4 the reversal links back and carries the reason", revAfter?.reverses_entry_id === orig.entry_id && revAfter?.reason === "Entered twice" && revAfter?.type === "reversal", JSON.stringify(revAfter));
  x = await tool(S, "reverse_journal_entry", { entry_id: orig.entry_id, reason: "again" });
  check("P0-4 an entry can only be reversed once", x.isError && /already/.test(x.text), x.text);
  await ok(S, "reverse_journal_entry", { entry_id: rev.reversal_entry_id, reason: "Entered once after all" });
  eq("P0-4 a reversal can itself be reversed (re-instating the original)", (await dashS()).cash, cashPre);
  const invEntry = await entryByMemo(/Invoice issued/, "invoice");
  x = await tool(S, "reverse_journal_entry", { entry_id: invEntry.entry_id, reason: "wrong" });
  check("P0-4 an invoice's own entry is refused, with the right tool named", x.isError && /cannot be reversed on its own/.test(x.text) && /issue_credit_note/.test(x.text), x.text);
  const buyEntry = await entryByMemo(/Stock received/, "purchase");
  x = await tool(S, "reverse_journal_entry", { entry_id: buyEntry.entry_id, reason: "wrong" });
  check("P0-4 a stock receipt's entry is refused", x.isError && /cannot be reversed on its own/.test(x.text), x.text);
  const revAudit = (await ok(S, "get_audit_log", { entity_type: "journal_entry", entity_id: orig.entry_id })).entries;
  check("P0-4 the reversal is in the audit log with its reason", revAudit.length === 1 && revAudit[0].detail.reason === "Entered twice" && revAudit[0].action === "reverse", JSON.stringify(revAudit));
  await balanced("P0-4");
  // reversing money that came in takes it out again, so the cash policy applies
  await ok(S, "update_settings", { cash_policy: "block" });
  await ok(S, "record_owner_investment", { amount: 70, memo: "Small capital" });
  const small = await entryByMemo(/Small capital/);
  const cashNow = (await dashS()).cash;
  await ok(S, "record_expense", { description: "Drain cash", amount: Math.round((cashNow - 30) * 100) / 100 }); // leaves 30: enough to keep cash positive, not enough to take 70 back out
  x = await tool(S, "reverse_journal_entry", { entry_id: small.entry_id, reason: "mistake" });
  check("P0-4 block: reversing money in is refused when the cash is gone", x.isError && /cash policy/i.test(x.text), x.text);
  await ok(S, "update_settings", { cash_policy: "warn" });
  x = await ok(S, "reverse_journal_entry", { entry_id: small.entry_id, reason: "mistake" });
  check("P0-4 warn: the same reversal goes through with a warning", x.warnings?.length === 1 && /negative/i.test(x.warnings[0]), JSON.stringify(x));
  await ok(S, "record_owner_investment", { amount: 1000, memo: "Restore cash" });
  await balanced("P0-4 after cash-policy reversals");

  // ---- P0-5 credit notes and stock returns
  await ok(S, "add_product", { sku: "C1", name: "Gadget", unit_price: 50, reorder_level: 5 });
  await ok(S, "receive_stock", { sku: "C1", qty: 20, unit_cost: 30, on_credit: true });
  const o1 = await ok(S, "create_order", { client: "Acme", items: [{ sku: "C1", qty: 10 }] });
  const f1 = await ok(S, "fulfill_order", { order_id: o1.order_id });
  const INV1 = f1.invoice.number;
  eq("P0-5 invoice total", f1.invoice.total, 500);
  const stockOf = async (sku) => (await ok(S, "list_products", { search: sku })).products.find((p) => p.sku === sku);

  x = await tool(S, "issue_credit_note", { invoice: INV1, reason: "damaged" });
  check("P0-5 for stock lines you must say whether goods came back", x.isError && /return_stock/.test(x.text), x.text);
  x = await tool(S, "issue_credit_note", { invoice: INV1, items: [{ line: 1, qty: 3 }], return_stock: true });
  check("P0-5 a reason is required", x.isError && /reason/.test(x.text), x.text);
  x = await tool(S, "issue_credit_note", { invoice: INV1, reason: "x", items: [{ line: 1, qty: 11 }], return_stock: true });
  check("P0-5 cannot credit more than was sold", x.isError && /left to credit/.test(x.text), x.text);
  x = await tool(S, "issue_credit_note", { invoice: INV1, reason: "x", items: [{ line: 2, qty: 1 }], return_stock: true });
  check("P0-5 unknown line rejected", x.isError && /no line 2/.test(x.text), x.text);
  x = await tool(KEY2, "issue_credit_note", { invoice: INV1, reason: "x", return_stock: true });
  check("P0-5 other tenant cannot credit my invoice", x.isError && /not found/.test(x.text), x.text);
  eq("P0-5 failed attempts changed nothing (stock)", (await stockOf("C1")).stock_qty, 10);

  // partial credit with the goods back
  const cn1 = await ok(S, "issue_credit_note", { invoice: INV1, reason: "3 damaged in transit", items: [{ line: 1, qty: 3 }], return_stock: true });
  eq("P0-5 first credit note number", cn1.number, "CN-00001");
  eq("P0-5 credit note total", cn1.total, 150);
  eq("P0-5 it reduced what the client owes", [cn1.applied_to_invoice, cn1.client_credit_created, cn1.invoice_balance_after], [150, 0, 350]);
  eq("P0-5 goods went back into stock", [(await stockOf("C1")).stock_qty, (await stockOf("C1")).unit_cost], [13, 30]);
  let iv = await ok(S, "get_invoice", { invoice: INV1 });
  eq("P0-5 invoice shows the credit", [iv.credited, iv.balance, iv.status, iv.items[0].credited_qty, iv.credit_notes.length], [150, 350, "open", 3, 1]);
  const cnEntry = await entryByMemo(/Credit note for/, "credit_note");
  check("P0-5 the posting references the original invoice", cnEntry.memo.includes(INV1), cnEntry.memo);
  eq("P0-5 the posting: revenue and receivable back, stock back at cost", cnEntry.lines.map((l) => [l.account, l.debit, l.credit]).sort(), [["1100 Accounts Receivable", 0, 150], ["1200 Inventory", 90, 0], ["4000 Sales Revenue", 150, 0], ["5000 Cost of Goods Sold", 0, 90]].sort());
  await balanced("P0-5 first credit note");

  // stock returns at the ORIGINAL cost even when the average has moved
  x = await ok(S, "receive_stock", { sku: "C1", qty: 7, unit_cost: 44, on_credit: true });
  eq("P0-5 average cost moved", [x.stock_qty, x.unit_cost], [20, 34.9]);
  const cn2 = await ok(S, "issue_credit_note", { invoice: INV1, reason: "5 more returned", items: [{ line: 1, qty: 5 }], return_stock: true });
  eq("P0-5 returned at the original cost", cn2.items[0].returned_at_cost, 30);
  eq("P0-5 average cost blends the returned units in", [(await stockOf("C1")).stock_qty, (await stockOf("C1")).unit_cost], [25, 33.92]);
  eq("P0-5 balance after two credit notes", cn2.invoice_balance_after, 100);

  // paid in full, then credit the rest: the excess becomes a client credit
  iv = await ok(S, "record_payment", { invoice: INV1, amount: 100, method: "bank transfer" });
  eq("P0-5 invoice settled by payment plus credits", [iv.status, iv.balance], ["paid", 0]);
  x = await tool(S, "record_payment", { invoice: INV1, amount: 1 });
  check("P0-5 nothing more can be paid on it", x.isError, x.text);
  const cn3 = await ok(S, "issue_credit_note", { invoice: INV1, reason: "2 refunded, not returned", items: [{ line: 1, qty: 2 }], return_stock: false });
  eq("P0-5 credit on a settled invoice becomes a client credit", [cn3.applied_to_invoice, cn3.client_credit_created, cn3.client_credit_balance, cn3.stock_returned], [0, 100, 100, false]);
  eq("P0-5 stock untouched when goods did not come back", (await stockOf("C1")).stock_qty, 25);
  eq("P0-5 dashboard shows the client credit", (await dashS()).client_credits, 100);
  eq("P0-5 client record shows the credit", (await ok(S, "get_client", { client: "Acme" })).credit_balance, 100);
  const cn3Entry = await entryByMemo(/2 refunded/, "credit_note");
  eq("P0-5 the excess posts to Customer Credits", cn3Entry.lines.map((l) => [l.account, l.debit, l.credit]).sort(), [["2100 Customer Credits", 0, 100], ["4000 Sales Revenue", 100, 0]].sort());
  x = await tool(S, "issue_credit_note", { invoice: INV1, reason: "again", return_stock: true });
  check("P0-5 an invoice cannot be credited past what was sold", x.isError && /already been credited/.test(x.text), x.text);
  await balanced("P0-5 client credit");

  // an unpaid invoice credited in full
  const o2 = await ok(S, "create_order", { client: "Acme", items: [{ sku: "C1", qty: 4 }] });
  const INV2 = (await ok(S, "fulfill_order", { order_id: o2.order_id })).invoice.number;
  const cn4 = await ok(S, "issue_credit_note", { invoice: INV2, reason: "order cancelled after shipping", return_stock: true });
  eq("P0-5 full credit with items left out", [cn4.total, cn4.applied_to_invoice, cn4.invoice_balance_after], [200, 200, 0]);
  eq("P0-5 stock came back", (await stockOf("C1")).stock_qty, 25);
  iv = await ok(S, "get_invoice", { invoice: INV2 });
  eq("P0-5 fully credited invoice shows as credited", [iv.status, iv.balance, iv.paid, iv.credited], ["credited", 0, 0, 200]);
  eq("P0-5 and can be listed that way", (await ok(S, "list_invoices", { status: "credited" })).invoices.map((i) => i.number), [INV2]);
  check("P0-5 ...and not as paid", !(await ok(S, "list_invoices", { status: "paid" })).invoices.some((i) => i.number === INV2));
  x = await tool(S, "record_payment", { invoice: INV2, amount: 1 });
  check("P0-5 a credited invoice cannot take payment", x.isError, x.text);
  x = await tool(S, "void_invoice", { invoice: INV2 });
  check("P0-5 a credited invoice cannot be voided", x.isError, x.text);
  check("P0-5 receivables aging leaves it out", !(await ok(S, "get_ar_aging")).invoices.some((i) => i.number === INV2));

  // services invoice: no goods, so no return_stock needed
  const svc = await ok(S, "create_invoice", { client: "Acme", items: [{ description: "Consulting", qty: 2, unit_price: 300 }] });
  const cn5 = await ok(S, "issue_credit_note", { invoice: svc.number, reason: "one hour waived", items: [{ line: 1, qty: 1 }] });
  eq("P0-5 partial credit on a services invoice", [cn5.total, cn5.invoice_balance_after, cn5.stock_returned], [300, 300, false]);

  // the books tie to the sub-ledgers
  const allInv = (await ok(S, "list_invoices", {})).invoices;
  eq("P0-5 receivables account equals the sum of invoice balances", await net("1100"), Math.round(allInv.reduce((s, i) => s + i.balance, 0) * 100) / 100);
  const allClients = (await ok(S, "list_clients")).clients;
  eq("P0-5 customer credits account equals the sum of client credits", -(await net("2100")), Math.round(allClients.reduce((s, c) => s + c.credit_balance, 0) * 100) / 100);
  const allProducts = (await ok(S, "list_products")).products;
  eq("P0-5 inventory account equals the value of stock on hand", await net("1200"), Math.round(allProducts.reduce((s, p) => s + p.stock_value, 0) * 100) / 100);
  await balanced("P0-5 final");
  check("P0-5 credit notes are in the audit log", (await ok(S, "get_audit_log", { entity_type: "credit_note" })).entries.length === 5);

  // ---- P0-6 onboarding visibility
  await ok(S, "create_client", { name: "Slow Co" });
  let lc = (await ok(S, "list_clients")).clients.find((c) => c.name === "Slow Co");
  eq("P0-6 new client: days pending and all three documents blocking", [lc.days_pending, lc.blocking_documents.map((b) => b.doc_type)], [0, ["authorized_signatory", "business_registration", "tax_id"]]);
  check("P0-6 each blocking document says who must act", lc.blocking_documents.every((b) => b.waiting_on === "client"));
  await ok(S, "update_client_document", { client: "Slow Co", doc_type: "tax_id", status: "received" });
  lc = (await ok(S, "list_clients")).clients.find((c) => c.name === "Slow Co");
  eq("P0-6 a received document now waits on a reviewer", lc.blocking_documents.find((b) => b.doc_type === "tax_id").waiting_on, "reviewer");
  await ok(S, "update_client_document", { client: "Slow Co", doc_type: "business_registration", status: "approved" });
  eq("P0-6 an approved document stops blocking", (await ok(S, "get_client", { client: "Slow Co" })).blocking_documents.map((b) => b.doc_type), ["authorized_signatory", "tax_id"]);
  d = await dashS();
  const att = d.onboarding_attention.find((c) => c.client === "Slow Co");
  check("P0-6 dashboard lists the stuck client with what blocks it", att && att.days_pending === 0 && att.blocking_documents.length === 2, JSON.stringify(att));
  check("P0-6 approved clients are not listed", !d.onboarding_attention.some((c) => c.client === "Acme"));
  await ok(S, "update_client_document", { client: "Slow Co", doc_type: "tax_id", status: "approved" });
  await ok(S, "update_client_document", { client: "Slow Co", doc_type: "authorized_signatory", status: "approved" });
  lc = (await ok(S, "list_clients")).clients.find((c) => c.name === "Slow Co");
  eq("P0-6 once approved nothing is pending", [lc.status, lc.days_pending, lc.blocking_documents], ["approved", null, []]);
  check("P0-6 and the dashboard drops it", !(await dashS()).onboarding_attention.some((c) => c.client === "Slow Co"));
  x = await tool(S, "create_order", { client: "Beta Co", items: [{ sku: "C1", qty: 1 }] });
  check("onboarding gate still holds for a client with documents outstanding", x.isError && /approved/i.test(x.text), x.text);
}

// ------------------------------------------------------------------ report
console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL:", f);
  process.exit(1);
}
