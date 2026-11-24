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

// ------------------------------------------------------------------ report
console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL:", f);
  process.exit(1);
}
