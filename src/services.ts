import { ACCOUNT, DEFAULT_ACCOUNTS, journalStatements } from "./ledger";
import {
  Args,
  Ctx,
  HttpError,
  addDays,
  daysBetween,
  optDate,
  optInt,
  optMoney,
  optStr,
  randomKey,
  reqArray,
  reqInt,
  reqMoney,
  reqStr,
  sha256Hex,
  toMajor as m,
  today,
  uid,
} from "./util";

const first = async <T>(s: D1PreparedStatement): Promise<T | null> => (await s.first<T>()) ?? null;
const all = async <T>(s: D1PreparedStatement): Promise<T[]> => (await s.all<T>()).results;

/** Run a batch (single transaction); translate constraint failures into friendly 409s. */
async function runBatch(ctx: Ctx, stmts: D1PreparedStatement[], conflictMsg: string) {
  try {
    await ctx.db.batch(stmts);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // The cash tripwire (cash_guard, migration 0003) fired: the whole batch rolled back.
    if (/CHECK constraint failed: ok = 1/i.test(msg))
      throw new HttpError(409, "Blocked by the cash policy: cash changed while this was being recorded, so it would now go negative. Nothing was recorded.");
    if (/CHECK constraint|UNIQUE constraint/i.test(msg)) throw new HttpError(409, conflictMsg);
    throw e;
  }
}

// ===========================================================================
// Audit trail and the cash policy (shared helpers)
// ===========================================================================

/** One append-only audit row. Put it in the same batch as the change it describes. */
function auditStatement(ctx: Ctx, action: string, entityType: string, entityId: string, detail: unknown): D1PreparedStatement {
  return ctx.db
    .prepare("INSERT INTO audit_log (org_id, action, entity_type, entity_id, detail) VALUES (?,?,?,?,?)")
    .bind(ctx.orgId, action, entityType, entityId, JSON.stringify(detail));
}

type CashPolicy = "block" | "warn" | "allow";
const CASH_POLICIES: CashPolicy[] = ["block", "warn", "allow"];

async function cashPolicy(ctx: Ctx): Promise<CashPolicy> {
  const r = await first<{ cash_policy: CashPolicy }>(ctx.db.prepare("SELECT cash_policy FROM org_settings WHERE org_id=?").bind(ctx.orgId));
  return r?.cash_policy ?? "warn";
}

/**
 * Apply the workspace cash policy to money that is about to leave the cash account.
 * - allow: nothing happens.
 * - warn: the action goes ahead and the caller gets a warning to show.
 * - block: refused up front with a friendly message. When it would be fine, the returned
 *   `guard` statements go at the END of the same D1 batch: the database re-checks cash after the
 *   journal entry is in and rolls the whole batch back if a concurrent request used the cash first.
 */
async function cashCheck(ctx: Ctx, outflow: number, alternative: string): Promise<{ guard: D1PreparedStatement[]; warnings: string[] }> {
  const none = { guard: [] as D1PreparedStatement[], warnings: [] as string[] };
  if (outflow <= 0) return none;
  const policy = await cashPolicy(ctx);
  if (policy === "allow") return none;
  const balance = await accountNet(ctx, ACCOUNT.CASH);
  const after = balance - outflow;
  if (after < 0) {
    const detail = `cash is ${m(balance)} and ${m(outflow)} would go out, leaving ${m(after)}`;
    if (policy === "block")
      throw new HttpError(
        409,
        `Blocked by the cash policy: ${detail}. Record the money coming in first with record_owner_investment, or ${alternative}. The policy can be changed with update_settings.`,
      );
    return { guard: [], warnings: [`Cash is negative: ${detail}. Record owner funding (record_owner_investment) or ${alternative}.`] };
  }
  if (policy === "block") {
    return {
      guard: [
        ctx.db
          .prepare(
            `INSERT INTO cash_guard (ok) SELECT CASE WHEN COALESCE((SELECT SUM(debit) - SUM(credit) FROM journal_lines WHERE org_id=? AND account_code=?), 0) >= 0 THEN 1 ELSE 0 END`,
          )
          .bind(ctx.orgId, ACCOUNT.CASH),
        ctx.db.prepare("DELETE FROM cash_guard"),
      ],
      warnings: [],
    };
  }
  return none;
}

export async function getSettings(ctx: Ctx) {
  return { cash_policy: await cashPolicy(ctx), cash_policies: CASH_POLICIES };
}

export async function updateSettings(ctx: Ctx, a: Args) {
  const policy = optStr(a, "cash_policy");
  if (policy === undefined) throw new HttpError(400, `Nothing to change: pass "cash_policy" (block, warn or allow)`);
  if (!CASH_POLICIES.includes(policy as CashPolicy)) throw new HttpError(400, `"cash_policy" must be block, warn or allow`);
  const before = await cashPolicy(ctx);
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO org_settings (org_id, cash_policy) VALUES (?,?)
         ON CONFLICT(org_id) DO UPDATE SET cash_policy=excluded.cash_policy, updated_at=datetime('now')`,
      )
      .bind(ctx.orgId, policy),
    auditStatement(ctx, "update", "settings", ctx.orgId, { cash_policy: { from: before, to: policy } }),
  ]);
  return getSettings(ctx);
}

export async function getAuditLog(ctx: Ctx, a: Args) {
  const limit = Math.min(optInt(a, "limit", 1, 50), 200);
  const entityType = optStr(a, "entity_type");
  const entityId = optStr(a, "entity_id");
  const rows = await all<{ id: number; at: string; actor: string; action: string; entity_type: string; entity_id: string; detail: string }>(
    ctx.db
      .prepare(
        `SELECT id, at, actor, action, entity_type, entity_id, detail FROM audit_log
         WHERE org_id=? ${entityType ? "AND entity_type=?" : ""} ${entityId ? "AND entity_id=?" : ""} ORDER BY id DESC LIMIT ?`,
      )
      .bind(...[ctx.orgId, ...(entityType ? [entityType] : []), ...(entityId ? [entityId] : []), limit]),
  );
  return {
    entries: rows.map((r) => ({
      at: r.at,
      actor: r.actor,
      action: r.action,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      detail: JSON.parse(r.detail) as unknown,
    })),
  };
}

// ===========================================================================
// Workspaces (tenants) and API keys
// ===========================================================================

export async function createOrg(db: D1Database, name: string) {
  const orgId = uid();
  const apiKey = randomKey();
  await db.batch([
    db.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").bind(orgId, name),
    ...DEFAULT_ACCOUNTS.map((a) =>
      db.prepare("INSERT INTO accounts (org_id, code, name, type) VALUES (?,?,?,?)").bind(orgId, a.code, a.name, a.type),
    ),
    db.prepare("INSERT INTO api_keys (id, org_id, key_hash, label) VALUES (?,?,?,?)").bind(uid(), orgId, await sha256Hex(apiKey), "initial"),
  ]);
  return { org_id: orgId, name, api_key: apiKey, note: "Store this key now. It is not shown again." };
}

export async function createApiKey(db: D1Database, orgId: string, label: string) {
  const org = await first<{ id: string }>(db.prepare("SELECT id FROM orgs WHERE id=?").bind(orgId));
  if (!org) throw new HttpError(404, "Workspace not found");
  const apiKey = randomKey();
  await db.prepare("INSERT INTO api_keys (id, org_id, key_hash, label) VALUES (?,?,?,?)").bind(uid(), orgId, await sha256Hex(apiKey), label).run();
  return { org_id: orgId, api_key: apiKey, note: "Store this key now. It is not shown again." };
}

/**
 * Emergency revoke: deletes every API key and every OAuth grant (codes, access and refresh tokens)
 * for the workspace, then issues one fresh key. Everything connected to it is signed out.
 */
export async function rotateKeys(db: D1Database, orgId: string, label: string) {
  const org = await first<{ id: string }>(db.prepare("SELECT id FROM orgs WHERE id=?").bind(orgId));
  if (!org) throw new HttpError(404, "Workspace not found");
  const apiKey = randomKey();
  await db.batch([
    db.prepare("DELETE FROM api_keys WHERE org_id=?").bind(orgId),
    db.prepare("DELETE FROM oauth_tokens WHERE org_id=?").bind(orgId),
    db.prepare("DELETE FROM oauth_codes WHERE org_id=?").bind(orgId),
    db.prepare("INSERT INTO api_keys (id, org_id, key_hash, label) VALUES (?,?,?,?)").bind(uid(), orgId, await sha256Hex(apiKey), label),
  ]);
  return { org_id: orgId, api_key: apiKey, note: "All previous keys and connected-app sign-ins were revoked. Store this key now. It is not shown again." };
}

export async function authenticate(db: D1Database, token: string | null): Promise<string | null> {
  if (!token) return null;
  const row = await first<{ org_id: string }>(db.prepare("SELECT org_id FROM api_keys WHERE key_hash=?").bind(await sha256Hex(token)));
  return row?.org_id ?? null;
}

// ===========================================================================
// Client onboarding
// ===========================================================================

interface ClientRow { id: string; name: string; email: string | null; status: string; created_at: string; credit_balance: number }
const CLIENT_COLS = "id,name,email,status,created_at,credit_balance";

/** Whole days since the client was added (used while they are not yet approved). */
const daysSince = (createdAt: string) => Math.max(0, daysBetween(createdAt.slice(0, 10), today()));

interface BlockingDoc { doc_type: string; status: string; waiting_on: "client" | "reviewer"; note: string | null }
const blockingDoc = (d: { doc_type: string; status: string; note: string | null }): BlockingDoc => ({
  doc_type: d.doc_type,
  status: d.status,
  // requested (or rejected, which goes back to requested) = the client owes it; received = waiting for approval
  waiting_on: d.status === "received" ? "reviewer" : "client",
  note: d.note,
});

/** Documents that are not yet approved, per client: the reason a client cannot be sold to. */
async function blockingDocuments(ctx: Ctx): Promise<Map<string, BlockingDoc[]>> {
  const rows = await all<{ client_id: string; doc_type: string; status: string; note: string | null }>(
    ctx.db.prepare("SELECT client_id, doc_type, status, note FROM client_documents WHERE org_id=? AND status != 'approved' ORDER BY doc_type").bind(ctx.orgId),
  );
  const out = new Map<string, BlockingDoc[]>();
  for (const r of rows) out.set(r.client_id, [...(out.get(r.client_id) ?? []), blockingDoc(r)]);
  return out;
}

async function resolveClient(ctx: Ctx, ref: string): Promise<ClientRow> {
  const rows = await all<ClientRow>(
    ctx.db.prepare(`SELECT ${CLIENT_COLS} FROM clients WHERE org_id=? AND (id=? OR lower(name)=lower(?))`).bind(ctx.orgId, ref, ref),
  );
  if (rows.length === 0) throw new HttpError(404, `Client "${ref}" not found`);
  const byId = rows.find((r) => r.id === ref);
  if (byId) return byId;
  if (rows.length > 1) throw new HttpError(409, `More than one client is named "${ref}". Use the client id.`);
  return rows[0];
}

async function recomputeClientStatus(ctx: Ctx, clientId: string) {
  const docs = await all<{ status: string }>(ctx.db.prepare("SELECT status FROM client_documents WHERE client_id=? AND org_id=?").bind(clientId, ctx.orgId));
  if (docs.length === 0) return;
  let status = "documents_pending";
  if (docs.every((d) => d.status === "approved")) status = "approved";
  else if (docs.every((d) => d.status === "approved" || d.status === "received")) status = "under_review";
  await ctx.db.prepare("UPDATE clients SET status=? WHERE id=? AND org_id=?").bind(status, clientId, ctx.orgId).run();
}

async function clientView(ctx: Ctx, client: ClientRow) {
  const documents = await all<{ doc_type: string; status: string; note: string | null; updated_at: string }>(
    ctx.db.prepare("SELECT doc_type, status, note, updated_at FROM client_documents WHERE client_id=? AND org_id=? ORDER BY doc_type").bind(client.id, ctx.orgId),
  );
  const c = (await first<ClientRow>(ctx.db.prepare(`SELECT ${CLIENT_COLS} FROM clients WHERE id=? AND org_id=?`).bind(client.id, ctx.orgId))) ?? client;
  const pending = c.status !== "approved";
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    status: c.status,
    created_at: c.created_at,
    credit_balance: m(c.credit_balance),
    days_pending: pending ? daysSince(c.created_at) : null,
    blocking_documents: pending ? documents.filter((d) => d.status !== "approved").map(blockingDoc) : [],
    documents,
  };
}

export async function createClient(ctx: Ctx, a: Args) {
  const name = reqStr(a, "name");
  const email = optStr(a, "email") ?? null;
  const dup = await first(ctx.db.prepare("SELECT id FROM clients WHERE org_id=? AND lower(name)=lower(?)").bind(ctx.orgId, name));
  if (dup) throw new HttpError(409, `A client named "${name}" already exists`);
  const docTypes = (ctx.env.REQUIRED_CLIENT_DOCS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const id = uid();
  await ctx.db.batch([
    ctx.db.prepare("INSERT INTO clients (id, org_id, name, email, status) VALUES (?,?,?,?,?)").bind(id, ctx.orgId, name, email, docTypes.length ? "documents_pending" : "approved"),
    ...docTypes.map((t) => ctx.db.prepare("INSERT INTO client_documents (id, org_id, client_id, doc_type) VALUES (?,?,?,?)").bind(uid(), ctx.orgId, id, t)),
  ]);
  return clientView(ctx, await resolveClient(ctx, id));
}

export async function getClient(ctx: Ctx, a: Args) {
  return clientView(ctx, await resolveClient(ctx, reqStr(a, "client")));
}

export async function listClients(ctx: Ctx, a: Args) {
  const status = optStr(a, "status");
  const rows = await all<{ id: string; name: string; email: string | null; status: string; created_at: string; credit_balance: number; documents_outstanding: number }>(
    ctx.db
      .prepare(
        `SELECT c.id, c.name, c.email, c.status, c.created_at, c.credit_balance,
                (SELECT COUNT(*) FROM client_documents d WHERE d.client_id=c.id AND d.status!='approved') AS documents_outstanding
         FROM clients c WHERE c.org_id=? ${status ? "AND c.status=?" : ""} ORDER BY c.name`,
      )
      .bind(...(status ? [ctx.orgId, status] : [ctx.orgId])),
  );
  const blocking = await blockingDocuments(ctx);
  return {
    clients: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      status: r.status,
      created_at: r.created_at,
      credit_balance: m(r.credit_balance),
      documents_outstanding: r.documents_outstanding,
      days_pending: r.status === "approved" ? null : daysSince(r.created_at),
      blocking_documents: r.status === "approved" ? [] : (blocking.get(r.id) ?? []),
    })),
  };
}

/** Edit contact details. Onboarding status can only move through update_client_document. */
export async function updateClient(ctx: Ctx, a: Args) {
  if (a["status"] !== undefined) throw new HttpError(400, "Onboarding status cannot be edited here: it follows the documents (use update_client_document).");
  const client = await resolveClient(ctx, reqStr(a, "client"));
  const name = optStr(a, "name");
  let email: string | null | undefined;
  if (a["email"] !== undefined) {
    const v = a["email"];
    if (v === null) email = null;
    else if (typeof v === "string") email = v.trim() || null; // "" clears the email
    else throw new HttpError(400, `"email" must be a string`);
  }
  if (name === undefined && email === undefined) throw new HttpError(400, `Nothing to change: pass "name" and/or "email"`);
  if (name !== undefined && name.toLowerCase() !== client.name.toLowerCase()) {
    const dup = await first(ctx.db.prepare("SELECT id FROM clients WHERE org_id=? AND lower(name)=lower(?) AND id != ?").bind(ctx.orgId, name, client.id));
    if (dup) throw new HttpError(409, `A client named "${name}" already exists`);
  }
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (name !== undefined && name !== client.name) changes.name = { from: client.name, to: name };
  if (email !== undefined && email !== client.email) changes.email = { from: client.email, to: email };
  if (Object.keys(changes).length) {
    await ctx.db.batch([
      ctx.db.prepare("UPDATE clients SET name=?, email=? WHERE id=? AND org_id=?").bind(name ?? client.name, email === undefined ? client.email : email, client.id, ctx.orgId),
      auditStatement(ctx, "update", "client", client.id, changes),
    ]);
  }
  return { ...(await clientView(ctx, client)), changes };
}

export async function updateClientDocument(ctx: Ctx, a: Args) {
  const client = await resolveClient(ctx, reqStr(a, "client"));
  const docType = reqStr(a, "doc_type").toLowerCase().replace(/\s+/g, "_");
  const status = reqStr(a, "status");
  if (!["requested", "received", "approved", "rejected"].includes(status))
    throw new HttpError(400, `"status" must be one of requested, received, approved, rejected`);
  // A rejected document goes back to the client, so it counts as outstanding again.
  const stored = status === "rejected" ? "requested" : status;
  const note = optStr(a, "note") ?? (status === "rejected" ? "Rejected: resubmission needed" : null);
  await ctx.db
    .prepare(
      `INSERT INTO client_documents (id, org_id, client_id, doc_type, status, note) VALUES (?,?,?,?,?,?)
       ON CONFLICT(client_id, doc_type) DO UPDATE SET status=excluded.status, note=excluded.note, updated_at=datetime('now')`,
    )
    .bind(uid(), ctx.orgId, client.id, docType, stored, note)
    .run();
  await recomputeClientStatus(ctx, client.id);
  return clientView(ctx, client);
}

async function requireApproved(ctx: Ctx, ref: string): Promise<ClientRow> {
  const c = await resolveClient(ctx, ref);
  if (c.status !== "approved")
    throw new HttpError(409, `Client "${c.name}" is ${c.status.replace("_", " ")}. Orders and invoices need an approved client: finish onboarding first.`);
  return c;
}

// ===========================================================================
// Products & inventory
// ===========================================================================

interface ProductRow { id: string; sku: string; name: string; unit_price: number; unit_cost: number; stock_qty: number; reorder_level: number }

async function resolveProduct(ctx: Ctx, sku: string): Promise<ProductRow> {
  const p = await first<ProductRow>(
    ctx.db.prepare("SELECT id,sku,name,unit_price,unit_cost,stock_qty,reorder_level FROM products WHERE org_id=? AND sku=?").bind(ctx.orgId, sku),
  );
  if (!p) throw new HttpError(404, `Product with SKU "${sku}" not found`);
  return p;
}

const productOut = (p: ProductRow) => ({
  sku: p.sku,
  name: p.name,
  unit_price: m(p.unit_price),
  unit_cost: m(p.unit_cost),
  stock_qty: p.stock_qty,
  stock_value: m(p.stock_qty * p.unit_cost),
  reorder_level: p.reorder_level,
  low_stock: p.stock_qty <= p.reorder_level,
});

export async function addProduct(ctx: Ctx, a: Args) {
  const sku = reqStr(a, "sku");
  const name = reqStr(a, "name");
  const unitPrice = reqMoney(a, "unit_price", true);
  // Required on purpose: 0 only flags a product once it is already out of stock, so make the caller choose.
  if (a["reorder_level"] === undefined || a["reorder_level"] === null)
    throw new HttpError(400, `"reorder_level" is required: the on-hand quantity at or below which this product is flagged as low stock (0 means only flag it once it is out of stock)`);
  const reorder = reqInt(a, "reorder_level", 0);
  if (await first(ctx.db.prepare("SELECT 1 FROM products WHERE org_id=? AND sku=?").bind(ctx.orgId, sku)))
    throw new HttpError(409, `SKU "${sku}" already exists`);
  await ctx.db
    .prepare("INSERT INTO products (id, org_id, sku, name, unit_price, unit_cost, reorder_level) VALUES (?,?,?,?,?,?,?)")
    .bind(uid(), ctx.orgId, sku, name, unitPrice, optMoney(a, "unit_cost", 0), reorder)
    .run();
  return productOut(await resolveProduct(ctx, sku));
}

/** Edit name, selling price or reorder level. Cost and stock never change here, and existing orders and invoices keep the price they were made at. */
export async function updateProduct(ctx: Ctx, a: Args) {
  for (const k of ["unit_cost", "cost", "stock_qty", "qty"])
    if (a[k] !== undefined) throw new HttpError(400, `"${k}" cannot be edited here: cost changes only through receive_stock, and stock only through receipts, sales and returns`);
  const p = await resolveProduct(ctx, reqStr(a, "sku"));
  const name = optStr(a, "name");
  const price = a["unit_price"] === undefined || a["unit_price"] === null ? undefined : reqMoney(a, "unit_price", true);
  const reorder = a["reorder_level"] === undefined || a["reorder_level"] === null ? undefined : reqInt(a, "reorder_level", 0);
  if (name === undefined && price === undefined && reorder === undefined)
    throw new HttpError(400, `Nothing to change: pass "name", "unit_price" and/or "reorder_level"`);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (name !== undefined && name !== p.name) changes.name = { from: p.name, to: name };
  if (price !== undefined && price !== p.unit_price) changes.unit_price = { from: m(p.unit_price), to: m(price) };
  if (reorder !== undefined && reorder !== p.reorder_level) changes.reorder_level = { from: p.reorder_level, to: reorder };
  if (Object.keys(changes).length) {
    await ctx.db.batch([
      ctx.db
        .prepare("UPDATE products SET name=?, unit_price=?, reorder_level=? WHERE id=? AND org_id=?")
        .bind(name ?? p.name, price ?? p.unit_price, reorder ?? p.reorder_level, p.id, ctx.orgId),
      auditStatement(ctx, "update", "product", p.id, { sku: p.sku, ...changes }),
    ]);
  }
  return { ...productOut(await resolveProduct(ctx, p.sku)), changes };
}

export async function listProducts(ctx: Ctx, a: Args) {
  const search = optStr(a, "search");
  const rows = await all<ProductRow>(
    ctx.db
      .prepare(
        `SELECT id,sku,name,unit_price,unit_cost,stock_qty,reorder_level FROM products
         WHERE org_id=? ${search ? "AND (sku LIKE ? OR name LIKE ?)" : ""} ORDER BY sku`,
      )
      .bind(...(search ? [ctx.orgId, `%${search}%`, `%${search}%`] : [ctx.orgId])),
  );
  return { products: rows.map(productOut) };
}

export async function lowStock(ctx: Ctx) {
  const rows = await all<ProductRow>(
    ctx.db.prepare("SELECT id,sku,name,unit_price,unit_cost,stock_qty,reorder_level FROM products WHERE org_id=? AND stock_qty <= reorder_level ORDER BY sku").bind(ctx.orgId),
  );
  return { products: rows.map(productOut) };
}

/** Receive stock from a supplier. Cost is tracked as a weighted average. */
export async function receiveStock(ctx: Ctx, a: Args) {
  const p = await resolveProduct(ctx, reqStr(a, "sku"));
  const qty = reqInt(a, "qty");
  const unitCost = reqMoney(a, "unit_cost", true);
  const onCredit = a["on_credit"] === true;
  const date = optDate(a, "date") ?? today();
  const total = qty * unitCost;
  const newQty = p.stock_qty + qty;
  const newCost = Math.round((p.stock_qty * p.unit_cost + qty * unitCost) / newQty);
  const cash = onCredit ? { guard: [], warnings: [] as string[] } : await cashCheck(ctx, total, "receive it on credit (on_credit: true)");
  await runBatch(
    ctx,
    [
      ctx.db.prepare("UPDATE products SET stock_qty=?, unit_cost=? WHERE id=? AND org_id=?").bind(newQty, newCost, p.id, ctx.orgId),
      ctx.db.prepare("INSERT INTO stock_movements (org_id, product_id, qty_change, reason) VALUES (?,?,?,?)").bind(ctx.orgId, p.id, qty, "purchase"),
      ...journalStatements(ctx.db, ctx.orgId, {
        date,
        memo: `Stock received: ${qty} x ${p.sku}${onCredit ? " (on credit)" : ""}`,
        refType: "purchase",
        refId: p.id,
        lines: [{ account: ACCOUNT.INVENTORY, debit: total }, { account: onCredit ? ACCOUNT.AP : ACCOUNT.CASH, credit: total }],
      }),
      ...cash.guard,
    ],
    "Could not receive stock",
  );
  const out = productOut(await resolveProduct(ctx, p.sku));
  return cash.warnings.length ? { ...out, warnings: cash.warnings } : out;
}

// ===========================================================================
// Orders
// ===========================================================================

async function orderView(ctx: Ctx, orderId: string) {
  const o = await first<{ id: string; status: string; invoice_id: string | null; created_at: string; client_id: string; client_name: string }>(
    ctx.db
      .prepare("SELECT o.id,o.status,o.invoice_id,o.created_at,o.client_id,c.name AS client_name FROM orders o JOIN clients c ON c.id=o.client_id WHERE o.id=? AND o.org_id=?")
      .bind(orderId, ctx.orgId),
  );
  if (!o) throw new HttpError(404, `Order "${orderId}" not found`);
  const items = await all<{ sku: string; name: string; qty: number; unit_price: number }>(
    ctx.db.prepare("SELECT p.sku,p.name,oi.qty,oi.unit_price FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=? ORDER BY oi.id").bind(orderId),
  );
  return {
    order_id: o.id,
    client: o.client_name,
    status: o.status,
    created_at: o.created_at,
    invoice_id: o.invoice_id,
    items: items.map((i) => ({ sku: i.sku, name: i.name, qty: i.qty, unit_price: m(i.unit_price), line_total: m(i.qty * i.unit_price) })),
    total: m(items.reduce((s, i) => s + i.qty * i.unit_price, 0)),
  };
}

export async function createOrder(ctx: Ctx, a: Args) {
  const client = await requireApproved(ctx, reqStr(a, "client"));
  const lines = reqArray(a, "items").map((it) => ({ sku: reqStr(it, "sku"), qty: reqInt(it, "qty") }));
  // merge duplicate SKUs
  const wanted = new Map<string, number>();
  for (const l of lines) wanted.set(l.sku, (wanted.get(l.sku) ?? 0) + l.qty);

  const resolved: { p: ProductRow; qty: number }[] = [];
  for (const [sku, qty] of wanted) {
    const p = await resolveProduct(ctx, sku);
    const reserved =
      (
        await first<{ r: number | null }>(
          ctx.db
            .prepare(
              `SELECT SUM(oi.qty) AS r FROM order_items oi JOIN orders o ON o.id=oi.order_id
               WHERE o.org_id=? AND o.status='confirmed' AND oi.product_id=?`,
            )
            .bind(ctx.orgId, p.id),
        )
      )?.r ?? 0;
    const available = p.stock_qty - reserved;
    if (qty > available)
      throw new HttpError(409, `Not enough stock for ${sku}: ${available} available (${p.stock_qty} on hand, ${reserved} reserved by other orders), ${qty} requested`);
    resolved.push({ p, qty });
  }
  const orderId = uid();
  await ctx.db.batch([
    ctx.db.prepare("INSERT INTO orders (id, org_id, client_id) VALUES (?,?,?)").bind(orderId, ctx.orgId, client.id),
    ...resolved.map(({ p, qty }) =>
      ctx.db.prepare("INSERT INTO order_items (order_id, product_id, qty, unit_price) VALUES (?,?,?,?)").bind(orderId, p.id, qty, p.unit_price),
    ),
  ]);
  return orderView(ctx, orderId);
}

export async function getOrder(ctx: Ctx, a: Args) {
  return orderView(ctx, reqStr(a, "order_id"));
}

export async function listOrders(ctx: Ctx, a: Args) {
  const status = optStr(a, "status");
  const rows = await all<{ id: string }>(
    ctx.db
      .prepare(`SELECT id FROM orders WHERE org_id=? ${status ? "AND status=?" : ""} ORDER BY created_at DESC, rowid DESC LIMIT 100`)
      .bind(...(status ? [ctx.orgId, status] : [ctx.orgId])),
  );
  return { orders: await Promise.all(rows.map((r) => orderView(ctx, r.id))) };
}

export async function cancelOrder(ctx: Ctx, a: Args) {
  const id = reqStr(a, "order_id");
  const o = await orderView(ctx, id);
  if (o.status !== "confirmed") throw new HttpError(409, `Only confirmed orders can be cancelled (this one is ${o.status})`);
  await ctx.db.prepare("UPDATE orders SET status='cancelled' WHERE id=? AND org_id=?").bind(id, ctx.orgId).run();
  return orderView(ctx, id);
}

// ===========================================================================
// Invoices & payments
// ===========================================================================

interface InvoiceRow {
  id: string; number: string; client_id: string; client_name: string; order_id: string | null;
  issue_date: string; due_date: string; status: string; total: number; paid: number; credited: number;
}

const INVOICE_SELECT = `SELECT i.id,i.number,i.client_id,c.name AS client_name,i.order_id,i.issue_date,i.due_date,i.status,i.total,i.paid,i.credited
                        FROM invoices i JOIN clients c ON c.id=i.client_id`;

/** What the client still owes on an invoice: total less payments less credit notes applied. */
const invoiceBalance = (i: { status: string; total: number; paid: number; credited: number }) => (i.status === "void" ? 0 : i.total - i.paid - i.credited);

// An invoice settled entirely by credit notes is stored as 'paid' (the status column cannot grow a new value
// without rebuilding the table) but shown as 'credited'.
const shownStatus = (i: { status: string; paid: number; credited: number }) => (i.status === "paid" && i.paid === 0 && i.credited > 0 ? "credited" : i.status);

function invoiceSummary(i: InvoiceRow) {
  const balance = invoiceBalance(i);
  const open = (i.status === "open" || i.status === "partial") && balance > 0;
  return {
    invoice_id: i.id,
    number: i.number,
    client: i.client_name,
    issue_date: i.issue_date,
    due_date: i.due_date,
    status: shownStatus(i),
    total: m(i.total),
    paid: m(i.paid),
    credited: m(i.credited),
    balance: m(balance),
    overdue: open && i.due_date < today(),
    days_overdue: open && i.due_date < today() ? daysBetween(i.due_date, today()) : 0,
  };
}

async function resolveInvoice(ctx: Ctx, ref: string): Promise<InvoiceRow> {
  const i = await first<InvoiceRow>(ctx.db.prepare(`${INVOICE_SELECT} WHERE i.org_id=? AND (i.id=? OR i.number=?)`).bind(ctx.orgId, ref, ref));
  if (!i) throw new HttpError(404, `Invoice "${ref}" not found`);
  return i;
}

async function invoiceView(ctx: Ctx, ref: string) {
  const i = await resolveInvoice(ctx, ref);
  const items = await all<{ description: string; qty: number; unit_price: number; credited_qty: number }>(
    ctx.db.prepare("SELECT description, qty, unit_price, credited_qty FROM invoice_items WHERE invoice_id=? ORDER BY id").bind(i.id),
  );
  const payments = await all<{ id: string; amount: number; method: string | null; date: string }>(
    ctx.db.prepare("SELECT id, amount, method, date FROM payments WHERE invoice_id=? ORDER BY date, rowid").bind(i.id),
  );
  const notes = await all<{ number: string; date: string; reason: string; total: number; applied: number; client_credit: number }>(
    ctx.db.prepare("SELECT number, date, reason, total, applied, client_credit FROM credit_notes WHERE invoice_id=? AND org_id=? ORDER BY rowid").bind(i.id, ctx.orgId),
  );
  return {
    ...invoiceSummary(i),
    order_id: i.order_id,
    items: items.map((x, idx) => ({ line: idx + 1, description: x.description, qty: x.qty, unit_price: m(x.unit_price), line_total: m(x.qty * x.unit_price), credited_qty: x.credited_qty })),
    payments: payments.map((p) => ({ payment_id: p.id, amount: m(p.amount), method: p.method, date: p.date })),
    credit_notes: notes.map((n) => ({ number: n.number, date: n.date, reason: n.reason, total: m(n.total), applied_to_invoice: m(n.applied), client_credit: m(n.client_credit) })),
  };
}

/** Statements that create an invoice and post Dr Accounts Receivable / Cr Sales Revenue. */
function invoiceStatements(
  ctx: Ctx,
  inv: {
    id: string; clientId: string; orderId?: string; issueDate: string; dueDate: string;
    // product_id / unit_cost are set for stock lines so a later return can restore the stock at its original cost
    items: { description: string; qty: number; unit_price: number; product_id?: string; unit_cost?: number }[];
  },
): D1PreparedStatement[] {
  const total = inv.items.reduce((s, x) => s + x.qty * x.unit_price, 0);
  return [
    ctx.db.prepare("UPDATE orgs SET invoice_seq = invoice_seq + 1 WHERE id=?").bind(ctx.orgId),
    ctx.db
      .prepare(
        `INSERT INTO invoices (id, org_id, number, client_id, order_id, issue_date, due_date, total)
         VALUES (?, ?, (SELECT 'INV-' || printf('%05d', invoice_seq) FROM orgs WHERE id=?), ?, ?, ?, ?, ?)`,
      )
      .bind(inv.id, ctx.orgId, ctx.orgId, inv.clientId, inv.orderId ?? null, inv.issueDate, inv.dueDate, total),
    ...inv.items.map((x) =>
      ctx.db
        .prepare("INSERT INTO invoice_items (invoice_id, description, qty, unit_price, product_id, unit_cost) VALUES (?,?,?,?,?,?)")
        .bind(inv.id, x.description, x.qty, x.unit_price, x.product_id ?? null, x.unit_cost ?? null),
    ),
    ...journalStatements(ctx.db, ctx.orgId, {
      date: inv.issueDate,
      memo: "Invoice issued",
      refType: "invoice",
      refId: inv.id,
      lines: [{ account: ACCOUNT.AR, debit: total }, { account: ACCOUNT.REVENUE, credit: total }],
    }),
  ];
}

export async function createInvoice(ctx: Ctx, a: Args) {
  const client = await requireApproved(ctx, reqStr(a, "client"));
  const items = reqArray(a, "items").map((it) => ({
    description: reqStr(it, "description"),
    qty: reqInt(it, "qty"),
    unit_price: reqMoney(it, "unit_price", true),
  }));
  const issueDate = optDate(a, "issue_date") ?? today();
  const dueDate = addDays(issueDate, optInt(a, "terms_days", 0, 30));
  const id = uid();
  await runBatch(ctx, invoiceStatements(ctx, { id, clientId: client.id, issueDate, dueDate, items }), "Could not create invoice");
  return invoiceView(ctx, id);
}

export async function fulfillOrder(ctx: Ctx, a: Args) {
  const orderId = reqStr(a, "order_id");
  const order = await first<{ id: string; client_id: string; status: string }>(
    ctx.db.prepare("SELECT id, client_id, status FROM orders WHERE id=? AND org_id=?").bind(orderId, ctx.orgId),
  );
  if (!order) throw new HttpError(404, `Order "${orderId}" not found`);
  if (order.status !== "confirmed") throw new HttpError(409, `Order is ${order.status}; only confirmed orders can be fulfilled`);

  const lines = await all<{ product_id: string; sku: string; name: string; qty: number; unit_price: number; unit_cost: number }>(
    ctx.db
      .prepare("SELECT oi.product_id, p.sku, p.name, oi.qty, oi.unit_price, p.unit_cost FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?")
      .bind(orderId),
  );
  const issueDate = optDate(a, "date") ?? today();
  const dueDate = addDays(issueDate, optInt(a, "terms_days", 0, 30));
  const invoiceId = uid();
  const cogs = lines.reduce((s, l) => s + l.qty * l.unit_cost, 0);

  await runBatch(
    ctx,
    [
      ...lines.flatMap((l) => [
        ctx.db.prepare("UPDATE products SET stock_qty = stock_qty - ? WHERE id=? AND org_id=?").bind(l.qty, l.product_id, ctx.orgId),
        ctx.db.prepare("INSERT INTO stock_movements (org_id, product_id, qty_change, reason, ref_id) VALUES (?,?,?,?,?)").bind(ctx.orgId, l.product_id, -l.qty, "sale", orderId),
      ]),
      ctx.db.prepare("UPDATE orders SET status='fulfilled', invoice_id=? WHERE id=? AND org_id=?").bind(invoiceId, orderId, ctx.orgId),
      ...invoiceStatements(ctx, {
        id: invoiceId,
        clientId: order.client_id,
        orderId,
        issueDate,
        dueDate,
        items: lines.map((l) => ({ description: `${l.name} (${l.sku})`, qty: l.qty, unit_price: l.unit_price, product_id: l.product_id, unit_cost: l.unit_cost })),
      }),
      ...journalStatements(ctx.db, ctx.orgId, {
        date: issueDate,
        memo: "Cost of goods sold",
        refType: "order",
        refId: orderId,
        lines: [{ account: ACCOUNT.COGS, debit: cogs }, { account: ACCOUNT.INVENTORY, credit: cogs }],
      }),
    ],
    "Could not fulfil the order: not enough stock on hand, or it was already fulfilled",
  );
  return { order: await orderView(ctx, orderId), invoice: await invoiceView(ctx, invoiceId) };
}

export async function getInvoice(ctx: Ctx, a: Args) {
  return invoiceView(ctx, reqStr(a, "invoice"));
}

export async function listInvoices(ctx: Ctx, a: Args) {
  const status = optStr(a, "status");
  const clientRef = optStr(a, "client");
  const overdueOnly = a["overdue_only"] === true;
  const client = clientRef ? await resolveClient(ctx, clientRef) : null;
  // 'credited' = settled entirely by credit notes (stored as 'paid' with nothing paid in)
  const statusSql: Record<string, string> = {
    open: "i.status='open'",
    partial: "i.status='partial'",
    paid: "(i.status='paid' AND NOT (i.paid=0 AND i.credited>0))",
    credited: "(i.status='paid' AND i.paid=0 AND i.credited>0)",
    void: "i.status='void'",
  };
  if (status && !statusSql[status]) throw new HttpError(400, `"status" must be one of ${Object.keys(statusSql).join(", ")}`);
  const rows = await all<InvoiceRow>(
    ctx.db
      .prepare(
        `${INVOICE_SELECT} WHERE i.org_id=? ${status ? "AND " + statusSql[status] : ""} ${client ? "AND i.client_id=?" : ""}
         ${overdueOnly ? "AND i.status IN ('open','partial') AND i.due_date < ?" : ""} ORDER BY i.issue_date DESC, i.number DESC LIMIT 200`,
      )
      .bind(...[ctx.orgId, ...(client ? [client.id] : []), ...(overdueOnly ? [today()] : [])]),
  );
  return { invoices: rows.map(invoiceSummary) };
}

export async function voidInvoice(ctx: Ctx, a: Args) {
  const i = await resolveInvoice(ctx, reqStr(a, "invoice"));
  if (i.status === "void") throw new HttpError(409, "Invoice is already void");
  if (i.paid > 0) throw new HttpError(409, "This invoice has payments recorded, so it cannot be voided. Issue a credit note (issue_credit_note) instead.");
  if (i.credited > 0) throw new HttpError(409, "This invoice already has credit notes, so it cannot be voided");
  if (i.order_id) throw new HttpError(409, "This invoice came from a fulfilled order. Voiding it would leave stock and cost of goods sold wrong, so it is not allowed. Issue a credit note (issue_credit_note) instead.");
  await runBatch(
    ctx,
    [
      ctx.db.prepare("UPDATE invoices SET status='void' WHERE id=? AND org_id=? AND paid=0 AND credited=0").bind(i.id, ctx.orgId),
      ...journalStatements(ctx.db, ctx.orgId, {
        date: today(),
        memo: `Void ${i.number}`,
        refType: "invoice_void",
        refId: i.id,
        lines: [{ account: ACCOUNT.REVENUE, debit: i.total }, { account: ACCOUNT.AR, credit: i.total }],
      }),
    ],
    "Could not void invoice",
  );
  return invoiceView(ctx, i.id);
}

export async function recordPayment(ctx: Ctx, a: Args) {
  const i = await resolveInvoice(ctx, reqStr(a, "invoice"));
  const amount = reqMoney(a, "amount");
  const date = optDate(a, "date") ?? today();
  if (i.status === "void") throw new HttpError(409, "Invoice is void");
  const balance = invoiceBalance(i);
  if (balance <= 0) throw new HttpError(409, `${i.number} is already fully ${i.credited > 0 && i.paid + i.credited >= i.total ? "settled" : "paid"}`);
  if (amount > balance) throw new HttpError(409, `Payment of ${m(amount)} exceeds the balance of ${m(balance)} on ${i.number}`);
  await runBatch(
    ctx,
    [
      ctx.db.prepare("INSERT INTO payments (id, org_id, invoice_id, amount, method, date) VALUES (?,?,?,?,?,?)").bind(uid(), ctx.orgId, i.id, amount, optStr(a, "method") ?? null, date),
      ctx.db
        .prepare("UPDATE invoices SET paid = paid + ?1, status = CASE WHEN paid + ?1 + credited >= total THEN 'paid' ELSE 'partial' END WHERE id=?2 AND org_id=?3")
        .bind(amount, i.id, ctx.orgId),
      ...journalStatements(ctx.db, ctx.orgId, {
        date,
        memo: `Payment received for ${i.number}`,
        refType: "payment",
        refId: i.id,
        lines: [{ account: ACCOUNT.CASH, debit: amount }, { account: ACCOUNT.AR, credit: amount }],
      }),
    ],
    "Payment could not be recorded (the balance may have changed). Reload the invoice and try again.",
  );
  return invoiceView(ctx, i.id);
}

// ===========================================================================
// Credit notes and stock returns
// ===========================================================================

async function creditNoteView(ctx: Ctx, id: string) {
  const n = await first<{ id: string; number: string; invoice_id: string; date: string; reason: string; total: number; applied: number; client_credit: number; stock_returned: number }>(
    ctx.db.prepare("SELECT id, number, invoice_id, date, reason, total, applied, client_credit, stock_returned FROM credit_notes WHERE id=? AND org_id=?").bind(id, ctx.orgId),
  );
  if (!n) throw new HttpError(404, "Credit note not found");
  const items = await all<{ description: string; qty: number; unit_price: number; unit_cost: number | null }>(
    ctx.db.prepare("SELECT description, qty, unit_price, unit_cost FROM credit_note_items WHERE credit_note_id=? ORDER BY id").bind(id),
  );
  const invoice = await invoiceView(ctx, n.invoice_id);
  const client = await first<{ name: string; credit_balance: number }>(
    ctx.db.prepare("SELECT c.name, c.credit_balance FROM clients c JOIN invoices i ON i.client_id=c.id WHERE i.id=? AND i.org_id=?").bind(n.invoice_id, ctx.orgId),
  );
  return {
    credit_note_id: n.id,
    number: n.number,
    invoice: invoice.number,
    client: client?.name,
    date: n.date,
    reason: n.reason,
    total: m(n.total),
    applied_to_invoice: m(n.applied),
    client_credit_created: m(n.client_credit),
    stock_returned: n.stock_returned === 1,
    items: items.map((x) => ({ description: x.description, qty: x.qty, unit_price: m(x.unit_price), line_total: m(x.qty * x.unit_price), ...(x.unit_cost === null ? {} : { returned_at_cost: m(x.unit_cost) }) })),
    invoice_balance_after: invoice.balance,
    client_credit_balance: m(client?.credit_balance ?? 0),
  };
}

/**
 * Correct an invoice that is already fulfilled or paid, in full or in part (by invoice line and quantity).
 * Posts Dr Sales Revenue / Cr Accounts Receivable for what the client still owed, and Cr Customer Credits for any
 * excess (money the client has already paid). When goods come back, also Dr Inventory / Cr Cost of Goods Sold at the
 * cost recorded when they were sold, and the product's average cost is updated. One D1 batch, so all or nothing.
 */
export async function issueCreditNote(ctx: Ctx, a: Args) {
  const inv = await resolveInvoice(ctx, reqStr(a, "invoice"));
  const reason = reqStr(a, "reason");
  const date = optDate(a, "date") ?? today();
  if (inv.status === "void") throw new HttpError(409, `${inv.number} is void: there is nothing to credit`);

  const lines = await all<{ id: number; description: string; qty: number; unit_price: number; product_id: string | null; unit_cost: number | null; credited_qty: number }>(
    ctx.db.prepare("SELECT id, description, qty, unit_price, product_id, unit_cost, credited_qty FROM invoice_items WHERE invoice_id=? ORDER BY id").bind(inv.id),
  );

  // which lines, and how many units of each (no "items" = everything not yet credited)
  const wanted = new Map<number, number>(); // index into lines -> qty
  if (a["items"] === undefined || a["items"] === null) {
    lines.forEach((l, idx) => { if (l.qty > l.credited_qty) wanted.set(idx, l.qty - l.credited_qty); });
  } else {
    for (const it of reqArray(a, "items")) {
      const n = reqInt(it, "line");
      if (n > lines.length) throw new HttpError(400, `${inv.number} has ${lines.length} line${lines.length === 1 ? "" : "s"}: there is no line ${n}`);
      wanted.set(n - 1, (wanted.get(n - 1) ?? 0) + reqInt(it, "qty"));
    }
  }
  if (wanted.size === 0) throw new HttpError(409, `Everything on ${inv.number} has already been credited`);
  const chosen = [...wanted].map(([idx, qty]) => {
    const line = lines[idx];
    const left = line.qty - line.credited_qty;
    if (qty > left) throw new HttpError(409, `Line ${idx + 1} (${line.description}): ${left} of ${line.qty} left to credit, ${qty} requested`);
    return { line, qty };
  });
  const total = chosen.reduce((s, c) => s + c.qty * c.line.unit_price, 0);
  if (total <= 0) throw new HttpError(400, "A credit note must be for more than zero");

  // goods: the caller must say whether they actually came back
  const stockLines = chosen.filter((c) => c.line.product_id);
  let returnStock = false;
  if (stockLines.length) {
    if (typeof a["return_stock"] !== "boolean")
      throw new HttpError(400, `Some of these lines are stock items. Set "return_stock": true if the goods came back (they go back into stock at their original cost) or false to credit the money only.`);
    returnStock = a["return_stock"];
    const unknown = stockLines.filter((c) => c.line.unit_cost === null);
    if (returnStock && unknown.length)
      throw new HttpError(409, `The original cost of ${unknown.map((c) => c.line.description).join(", ")} was not recorded (it was invoiced before credit notes existed), so its stock cannot be returned automatically. Use "return_stock": false to credit the money only.`);
  }

  // split between what the client still owes (reduces the invoice) and money they already paid (becomes a client credit)
  const applied = Math.min(total, Math.max(invoiceBalance(inv), 0));
  const clientCredit = total - applied;
  const returnedCost = returnStock ? stockLines.reduce((s, c) => s + c.qty * (c.line.unit_cost ?? 0), 0) : 0;

  const id = uid();
  await runBatch(
    ctx,
    [
      ctx.db.prepare("UPDATE orgs SET credit_note_seq = credit_note_seq + 1 WHERE id=?").bind(ctx.orgId),
      ctx.db
        .prepare(
          `INSERT INTO credit_notes (id, org_id, number, invoice_id, client_id, date, reason, total, applied, client_credit, stock_returned)
           VALUES (?, ?, (SELECT 'CN-' || printf('%05d', credit_note_seq) FROM orgs WHERE id=?), ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, ctx.orgId, ctx.orgId, inv.id, inv.client_id, date, reason, total, applied, clientCredit, returnStock ? 1 : 0),
      ...chosen.flatMap((c) => {
        const back = returnStock && c.line.product_id !== null;
        return [
          ctx.db
            .prepare("INSERT INTO credit_note_items (credit_note_id, invoice_item_id, description, qty, unit_price, product_id, unit_cost) VALUES (?,?,?,?,?,?,?)")
            .bind(id, c.line.id, c.line.description, c.qty, c.line.unit_price, back ? c.line.product_id : null, back ? c.line.unit_cost : null),
          // the database refuses credited_qty > qty, so two notes cannot credit the same units twice
          ctx.db.prepare("UPDATE invoice_items SET credited_qty = credited_qty + ? WHERE id=? AND invoice_id=?").bind(c.qty, c.line.id, inv.id),
          ...(back
            ? [
                // stock goes back at the original cost; the average cost is recomputed in SQL so it cannot race
                ctx.db
                  .prepare(
                    `UPDATE products SET
                       unit_cost = CASE WHEN stock_qty + ?1 > 0 THEN CAST(ROUND(1.0 * (stock_qty * unit_cost + ?1 * ?2) / (stock_qty + ?1)) AS INTEGER) ELSE unit_cost END,
                       stock_qty = stock_qty + ?1
                     WHERE id=?3 AND org_id=?4`,
                  )
                  .bind(c.qty, c.line.unit_cost, c.line.product_id, ctx.orgId),
                ctx.db
                  .prepare("INSERT INTO stock_movements (org_id, product_id, qty_change, reason, ref_id) VALUES (?,?,?,?,?)")
                  .bind(ctx.orgId, c.line.product_id, c.qty, "return", id),
              ]
            : []),
        ];
      }),
      // the database refuses paid + credited > total, so a payment that lands meanwhile makes this whole batch roll back
      ctx.db
        .prepare("UPDATE invoices SET credited = credited + ?1, status = CASE WHEN ?1 > 0 AND paid + credited + ?1 >= total THEN 'paid' ELSE status END WHERE id=?2 AND org_id=?3")
        .bind(applied, inv.id, ctx.orgId),
      ...(clientCredit > 0 ? [ctx.db.prepare("UPDATE clients SET credit_balance = credit_balance + ? WHERE id=? AND org_id=?").bind(clientCredit, inv.client_id, ctx.orgId)] : []),
      ...journalStatements(ctx.db, ctx.orgId, {
        date,
        memo: `Credit note for ${inv.number}: ${reason}`,
        refType: "credit_note",
        refId: id,
        lines: [
          { account: ACCOUNT.REVENUE, debit: total },
          { account: ACCOUNT.AR, credit: applied },
          { account: ACCOUNT.CUSTOMER_CREDITS, credit: clientCredit },
          { account: ACCOUNT.INVENTORY, debit: returnedCost },
          { account: ACCOUNT.COGS, credit: returnedCost },
        ],
      }),
      auditStatement(ctx, "create", "credit_note", id, { invoice: inv.number, reason, total: m(total), applied: m(applied), client_credit: m(clientCredit), stock_returned: returnStock }),
    ],
    "Could not issue the credit note: the invoice or its lines changed in the meantime (for example a payment or another credit note). Reload the invoice and try again.",
  );
  return creditNoteView(ctx, id);
}

// ===========================================================================
// General accounting: capital, expenses, supplier payments, accounts, journal
// ===========================================================================

export async function recordOwnerInvestment(ctx: Ctx, a: Args) {
  const amount = reqMoney(a, "amount");
  const date = optDate(a, "date") ?? today();
  await ctx.db.batch(
    journalStatements(ctx.db, ctx.orgId, {
      date,
      memo: optStr(a, "memo") ?? "Owner investment",
      refType: "capital",
      lines: [{ account: ACCOUNT.CASH, debit: amount }, { account: ACCOUNT.EQUITY, credit: amount }],
    }),
  );
  return { recorded: true, amount: m(amount), date };
}

export async function recordExpense(ctx: Ctx, a: Args) {
  const amount = reqMoney(a, "amount");
  const code = optStr(a, "account_code") ?? ACCOUNT.OPEX;
  const acct = await first<{ type: string; name: string }>(ctx.db.prepare("SELECT type, name FROM accounts WHERE org_id=? AND code=?").bind(ctx.orgId, code));
  if (!acct) throw new HttpError(404, `Account ${code} not found`);
  if (acct.type !== "expense") throw new HttpError(400, `Account ${code} (${acct.name}) is not an expense account`);
  const onCredit = optStr(a, "paid_from") === "payable";
  const date = optDate(a, "date") ?? today();
  const cash = onCredit ? { guard: [], warnings: [] as string[] } : await cashCheck(ctx, amount, "record the expense as payable (paid_from: payable)");
  await runBatch(
    ctx,
    [
      ...journalStatements(ctx.db, ctx.orgId, {
        date,
        memo: reqStr(a, "description"),
        refType: "expense",
        lines: [{ account: code, debit: amount }, { account: onCredit ? ACCOUNT.AP : ACCOUNT.CASH, credit: amount }],
      }),
      ...cash.guard,
    ],
    "Could not record the expense",
  );
  return {
    recorded: true,
    account: `${code} ${acct.name}`,
    amount: m(amount),
    paid_from: onCredit ? "accounts payable" : "cash",
    date,
    ...(cash.warnings.length ? { warnings: cash.warnings } : {}),
  };
}

export async function paySupplier(ctx: Ctx, a: Args) {
  const amount = reqMoney(a, "amount");
  const date = optDate(a, "date") ?? today();
  const bal = await accountNet(ctx, ACCOUNT.AP);
  const owed = -bal; // liabilities carry credit balances
  if (amount > owed) throw new HttpError(409, `Payment of ${m(amount)} exceeds accounts payable of ${m(Math.max(owed, 0))}`);
  const cash = await cashCheck(ctx, amount, "pay a smaller amount");
  await runBatch(
    ctx,
    [
      ...journalStatements(ctx.db, ctx.orgId, {
        date,
        memo: optStr(a, "memo") ?? "Supplier payment",
        refType: "supplier_payment",
        lines: [{ account: ACCOUNT.AP, debit: amount }, { account: ACCOUNT.CASH, credit: amount }],
      }),
      ...cash.guard,
    ],
    "Could not record the supplier payment",
  );
  return { recorded: true, amount: m(amount), payable_remaining: m(owed - amount), ...(cash.warnings.length ? { warnings: cash.warnings } : {}) };
}

export async function listAccounts(ctx: Ctx) {
  return { accounts: await all(ctx.db.prepare("SELECT code, name, type FROM accounts WHERE org_id=? ORDER BY code").bind(ctx.orgId)) };
}

export async function addAccount(ctx: Ctx, a: Args) {
  const code = reqStr(a, "code");
  const name = reqStr(a, "name");
  const type = reqStr(a, "type");
  if (!/^\d{3,6}$/.test(code)) throw new HttpError(400, `"code" must be 3 to 6 digits`);
  if (!["asset", "liability", "equity", "revenue", "expense"].includes(type)) throw new HttpError(400, `"type" must be asset, liability, equity, revenue or expense`);
  if (await first(ctx.db.prepare("SELECT 1 FROM accounts WHERE org_id=? AND code=?").bind(ctx.orgId, code))) throw new HttpError(409, `Account ${code} already exists`);
  await ctx.db.prepare("INSERT INTO accounts (org_id, code, name, type) VALUES (?,?,?,?)").bind(ctx.orgId, code, name, type).run();
  return { code, name, type };
}

// Entries tied to a document whose own state would drift if only the ledger entry were reversed.
const NOT_REVERSIBLE: Record<string, string> = {
  invoice: "It belongs to an invoice: use void_invoice for an unpaid free-form invoice, or issue_credit_note for any other invoice.",
  invoice_void: "It belongs to a voided invoice, which cannot be undone.",
  payment: "It records a customer payment: reversing only the ledger entry would leave the invoice showing as paid. Payment reversal is not available yet.",
  purchase: "It is a stock receipt: reversing only the ledger entry would leave the stock quantity and cost wrong.",
  order: "It is the cost of goods sold for a shipped order: use issue_credit_note with return_stock to take goods back.",
  credit_note: "It belongs to a credit note, which cannot be undone.",
};

/**
 * Correct a posted entry without touching it: post a new entry that mirrors every line with debit and credit swapped,
 * linked to the original and with a required reason. The original stays exactly as it was; reports see both.
 */
export async function reverseJournalEntry(ctx: Ctx, a: Args) {
  const entryId = reqStr(a, "entry_id");
  const reason = reqStr(a, "reason");
  const date = optDate(a, "date") ?? today();
  const orig = await first<{ id: string; memo: string; ref_type: string | null }>(
    ctx.db.prepare("SELECT id, memo, ref_type FROM journal_entries WHERE id=? AND org_id=?").bind(entryId, ctx.orgId),
  );
  if (!orig) throw new HttpError(404, `Journal entry "${entryId}" not found`);
  if (orig.ref_type && NOT_REVERSIBLE[orig.ref_type]) throw new HttpError(409, `This entry cannot be reversed on its own. ${NOT_REVERSIBLE[orig.ref_type]}`);
  if (await first(ctx.db.prepare("SELECT id FROM journal_entries WHERE org_id=? AND reverses_entry_id=?").bind(ctx.orgId, orig.id)))
    throw new HttpError(409, "This entry has already been reversed");

  // reversing an entry that brought cash in takes that cash out again, so the cash policy applies
  const cashIn = await first<{ n: number }>(
    ctx.db.prepare("SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS n FROM journal_lines WHERE entry_id=? AND org_id=? AND account_code=?").bind(orig.id, ctx.orgId, ACCOUNT.CASH),
  );
  const cash = await cashCheck(ctx, Math.max(cashIn?.n ?? 0, 0), "reverse it later, once the business has the cash");

  const id = uid();
  await runBatch(
    ctx,
    [
      ctx.db
        .prepare("INSERT INTO journal_entries (id, org_id, date, memo, ref_type, ref_id, reverses_entry_id, reason) VALUES (?,?,?,?,?,?,?,?)")
        .bind(id, ctx.orgId, date, `Reversal of: ${orig.memo}`, "reversal", orig.id, orig.id, reason),
      // copied line by line from the original with debit and credit swapped, so it balances by construction
      ctx.db
        .prepare("INSERT INTO journal_lines (entry_id, org_id, account_code, debit, credit) SELECT ?, org_id, account_code, credit, debit FROM journal_lines WHERE entry_id=? AND org_id=? ORDER BY id")
        .bind(id, orig.id, ctx.orgId),
      ...cash.guard,
      auditStatement(ctx, "reverse", "journal_entry", orig.id, { reversal_entry_id: id, reason, date }),
    ],
    "This entry has already been reversed",
  );
  const lines = await all<{ account_code: string; name: string; debit: number; credit: number }>(
    ctx.db
      .prepare(
        `SELECT l.account_code, a.name, l.debit, l.credit FROM journal_lines l
         JOIN accounts a ON a.org_id=l.org_id AND a.code=l.account_code WHERE l.entry_id=? AND l.org_id=? ORDER BY l.id`,
      )
      .bind(id, ctx.orgId),
  );
  return {
    reversal_entry_id: id,
    reverses_entry_id: orig.id,
    date,
    reason,
    lines: lines.map((l) => ({ account: `${l.account_code} ${l.name}`, debit: m(l.debit), credit: m(l.credit) })),
    ...(cash.warnings.length ? { warnings: cash.warnings } : {}),
  };
}

export async function getJournal(ctx: Ctx, a: Args) {
  const limit = Math.min(optInt(a, "limit", 1, 20), 100);
  const entries = await all<{ id: string; date: string; memo: string; ref_type: string | null; reverses_entry_id: string | null; reason: string | null; reversed_by: string | null }>(
    ctx.db
      .prepare(
        `SELECT e.id, e.date, e.memo, e.ref_type, e.reverses_entry_id, e.reason,
                (SELECT r.id FROM journal_entries r WHERE r.org_id=e.org_id AND r.reverses_entry_id=e.id) AS reversed_by
         FROM journal_entries e WHERE e.org_id=? ORDER BY e.date DESC, e.created_at DESC, e.rowid DESC LIMIT ?`,
      )
      .bind(ctx.orgId, limit),
  );
  const out = [];
  for (const e of entries) {
    const lines = await all<{ account_code: string; name: string; debit: number; credit: number }>(
      ctx.db
        .prepare(
          `SELECT l.account_code, a.name, l.debit, l.credit FROM journal_lines l
           JOIN accounts a ON a.org_id=l.org_id AND a.code=l.account_code WHERE l.entry_id=? ORDER BY l.id`,
        )
        .bind(e.id),
    );
    out.push({
      entry_id: e.id,
      date: e.date,
      memo: e.memo,
      type: e.ref_type,
      ...(e.reverses_entry_id ? { reverses_entry_id: e.reverses_entry_id, reason: e.reason } : {}),
      ...(e.reversed_by ? { reversed_by: e.reversed_by } : {}),
      lines: lines.map((l) => ({ account: `${l.account_code} ${l.name}`, debit: m(l.debit), credit: m(l.credit) })),
    });
  }
  return { entries: out };
}

// ===========================================================================
// Reports
// ===========================================================================

interface BalanceRow { code: string; name: string; type: string; debit: number; credit: number }

async function accountBalances(ctx: Ctx, from = "0000-01-01", to = "9999-12-31"): Promise<BalanceRow[]> {
  return all<BalanceRow>(
    ctx.db
      .prepare(
        `SELECT a.code, a.name, a.type, COALESCE(SUM(l.debit),0) AS debit, COALESCE(SUM(l.credit),0) AS credit
         FROM accounts a
         LEFT JOIN (
           SELECT jl.account_code, jl.debit, jl.credit FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
           WHERE jl.org_id=?1 AND je.date >= ?2 AND je.date <= ?3
         ) l ON l.account_code = a.code
         WHERE a.org_id=?1 GROUP BY a.code, a.name, a.type ORDER BY a.code`,
      )
      .bind(ctx.orgId, from, to),
  );
}

async function accountNet(ctx: Ctx, code: string): Promise<number> {
  const r = (await accountBalances(ctx)).find((x) => x.code === code);
  return r ? r.debit - r.credit : 0;
}

export async function trialBalance(ctx: Ctx, a: Args) {
  const asOf = optDate(a, "as_of") ?? today();
  const rows = await accountBalances(ctx, undefined, asOf);
  const lines = rows.map((r) => {
    const net = r.debit - r.credit;
    return { account: `${r.code} ${r.name}`, type: r.type, debit: m(net > 0 ? net : 0), credit: m(net < 0 ? -net : 0) };
  });
  const debit = lines.reduce((s, l) => s + Math.round(l.debit * 100), 0);
  const credit = lines.reduce((s, l) => s + Math.round(l.credit * 100), 0);
  return { as_of: asOf, lines, total_debit: m(debit), total_credit: m(credit), balanced: debit === credit };
}

export async function profitAndLoss(ctx: Ctx, a: Args) {
  const to = optDate(a, "to") ?? today();
  const from = optDate(a, "from") ?? `${to.slice(0, 7)}-01`;
  const rows = await accountBalances(ctx, from, to);
  const revenue = rows.filter((r) => r.type === "revenue").map((r) => ({ account: `${r.code} ${r.name}`, amount: r.credit - r.debit }));
  const expenses = rows.filter((r) => r.type === "expense").map((r) => ({ account: `${r.code} ${r.name}`, amount: r.debit - r.credit }));
  const totalRevenue = revenue.reduce((s, r) => s + r.amount, 0);
  const totalExpenses = expenses.reduce((s, r) => s + r.amount, 0);
  const cogs = rows.find((r) => r.code === ACCOUNT.COGS);
  const cogsAmt = cogs ? cogs.debit - cogs.credit : 0;
  return {
    from,
    to,
    revenue: revenue.map((r) => ({ ...r, amount: m(r.amount) })),
    total_revenue: m(totalRevenue),
    expenses: expenses.map((r) => ({ ...r, amount: m(r.amount) })),
    total_expenses: m(totalExpenses),
    gross_profit: m(totalRevenue - cogsAmt),
    net_income: m(totalRevenue - totalExpenses),
  };
}

export async function arAging(ctx: Ctx) {
  const t = today();
  const rows = await all<InvoiceRow>(
    ctx.db.prepare(`${INVOICE_SELECT} WHERE i.org_id=? AND i.status IN ('open','partial') ORDER BY i.due_date`).bind(ctx.orgId),
  );
  const buckets = { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, days_over_90: 0 };
  const perClient = new Map<string, typeof buckets & { total: number }>();
  const invoices = rows.map((i) => {
    const bal = invoiceBalance(i);
    const late = i.due_date < t ? daysBetween(i.due_date, t) : 0;
    const bucket: keyof typeof buckets = late === 0 ? "current" : late <= 30 ? "days_1_30" : late <= 60 ? "days_31_60" : late <= 90 ? "days_61_90" : "days_over_90";
    buckets[bucket] += bal;
    const c = perClient.get(i.client_name) ?? { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, days_over_90: 0, total: 0 };
    c[bucket] += bal;
    c.total += bal;
    perClient.set(i.client_name, c);
    return { number: i.number, client: i.client_name, due_date: i.due_date, balance: m(bal), days_overdue: late, bucket };
  });
  const conv = (b: typeof buckets) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, m(v)]));
  return {
    as_of: t,
    totals: { ...conv(buckets), total: m(Object.values(buckets).reduce((s, v) => s + v, 0)) },
    by_client: [...perClient].map(([client, b]) => ({ client, ...conv(b), total: m(b.total) })),
    invoices,
  };
}

export async function dashboard(ctx: Ctx) {
  const t = today();
  const monthStart = `${t.slice(0, 7)}-01`;
  const all_ = await accountBalances(ctx);
  const net = (code: string) => {
    const r = all_.find((x) => x.code === code);
    return r ? r.debit - r.credit : 0;
  };
  const month = await accountBalances(ctx, monthStart, t);
  const rev = month.filter((r) => r.type === "revenue").reduce((s, r) => s + r.credit - r.debit, 0);
  const exp = month.filter((r) => r.type === "expense").reduce((s, r) => s + r.debit - r.credit, 0);
  const overdue = await first<{ n: number; amt: number | null }>(
    ctx.db.prepare("SELECT COUNT(*) AS n, SUM(total-paid-credited) AS amt FROM invoices WHERE org_id=? AND status IN ('open','partial') AND due_date < ?").bind(ctx.orgId, t),
  );
  const open = await first<{ n: number; amt: number | null }>(
    ctx.db.prepare("SELECT COUNT(*) AS n, SUM(total-paid-credited) AS amt FROM invoices WHERE org_id=? AND status IN ('open','partial')").bind(ctx.orgId),
  );
  const low = await first<{ n: number }>(ctx.db.prepare("SELECT COUNT(*) AS n FROM products WHERE org_id=? AND stock_qty <= reorder_level").bind(ctx.orgId));
  const noLevel = await first<{ n: number }>(ctx.db.prepare("SELECT COUNT(*) AS n FROM products WHERE org_id=? AND reorder_level = 0").bind(ctx.orgId));
  const awaiting = await first<{ n: number }>(ctx.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE org_id=? AND status='confirmed'").bind(ctx.orgId));
  const clients = await all<{ status: string; n: number }>(ctx.db.prepare("SELECT status, COUNT(*) AS n FROM clients WHERE org_id=? GROUP BY status").bind(ctx.orgId));

  // clients stuck in onboarding, oldest first, with what is blocking each one
  const stuck = await all<{ id: string; name: string; status: string; created_at: string }>(
    ctx.db.prepare("SELECT id, name, status, created_at FROM clients WHERE org_id=? AND status != 'approved' ORDER BY created_at, rowid LIMIT 10").bind(ctx.orgId),
  );
  const blocking = stuck.length ? await blockingDocuments(ctx) : new Map<string, BlockingDoc[]>();

  const cash = net(ACCOUNT.CASH);
  const policy = await cashPolicy(ctx);
  const warnings: string[] = [];
  if (cash < 0)
    warnings.push(`Cash is negative (${m(cash)}). Money went out that was never put in: record owner funding with record_owner_investment, or check what was paid in cash. Cash policy: ${policy}.`);
  if ((noLevel?.n ?? 0) > 0)
    warnings.push(`${noLevel?.n} product${noLevel?.n === 1 ? " has" : "s have"} no reorder level, so ${noLevel?.n === 1 ? "it only shows" : "they only show"} as low stock once out of stock. Set one with update_product.`);

  return {
    as_of: t,
    currency: ctx.env.CURRENCY,
    cash: m(cash),
    cash_policy: policy,
    accounts_receivable: m(net(ACCOUNT.AR)),
    inventory_value: m(net(ACCOUNT.INVENTORY)),
    accounts_payable: m(-net(ACCOUNT.AP)),
    client_credits: m(-net(ACCOUNT.CUSTOMER_CREDITS)),
    open_invoices: { count: open?.n ?? 0, amount: m(open?.amt ?? 0) },
    overdue_invoices: { count: overdue?.n ?? 0, amount: m(overdue?.amt ?? 0) },
    this_month: { revenue: m(rev), expenses: m(exp), net_income: m(rev - exp) },
    low_stock_products: low?.n ?? 0,
    products_without_reorder_level: noLevel?.n ?? 0,
    orders_awaiting_fulfilment: awaiting?.n ?? 0,
    clients_by_status: Object.fromEntries(clients.map((c) => [c.status, c.n])),
    onboarding_attention: stuck.map((c) => ({ client: c.name, client_id: c.id, status: c.status, days_pending: daysSince(c.created_at), blocking_documents: blocking.get(c.id) ?? [] })),
    warnings,
  };
}
