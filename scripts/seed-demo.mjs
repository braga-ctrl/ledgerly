// Fill a workspace with realistic demo data, e.g. for the reviewer account the directory asks for.
//
//   BASE_URL=https://ledgerly.your-name.workers.dev API_KEY=lgk_... node scripts/seed-demo.mjs
//
// Run it ONCE on an empty workspace. It refuses to run if the workspace already has clients.
const BASE = (process.env.BASE_URL || "").replace(/\/$/, "");
const KEY = process.env.API_KEY;
if (!BASE || !KEY) {
  console.error("Set BASE_URL and API_KEY (a workspace key starting with lgk_).");
  process.exit(1);
}

async function call(name, args = {}) {
  const res = await fetch(`${BASE}/api/tools/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(args),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${name}: ${json.error || res.status}`);
  return json;
}

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

if ((await call("list_clients")).clients.length > 0) {
  console.error("This workspace already has clients. Use an empty workspace.");
  process.exit(1);
}

console.log("Seeding capital, expense accounts and catalogue...");
await call("record_owner_investment", { amount: 50000, memo: "Opening capital", date: daysAgo(90) });
await call("add_account", { code: "6100", name: "Rent", type: "expense" });
await call("add_account", { code: "6200", name: "Software and Subscriptions", type: "expense" });

const catalogue = [
  { sku: "PAL-100", name: "Pallet wrap, 500mm", unit_price: 14.5, reorder_level: 40, qty: 300, cost: 8.2 },
  { sku: "BOX-M", name: "Shipping box, medium", unit_price: 2.2, reorder_level: 200, qty: 1500, cost: 1.05 },
  { sku: "TAPE-48", name: "Packing tape, 48mm", unit_price: 3.4, reorder_level: 100, qty: 600, cost: 1.6 },
  { sku: "LBL-A5", name: "Thermal labels, A5 (roll)", unit_price: 9.9, reorder_level: 60, qty: 90, cost: 5.75 },
  { sku: "GLV-L", name: "Work gloves, large (pair)", unit_price: 6.25, reorder_level: 80, qty: 150, cost: 3.4 },
];
for (const p of catalogue) {
  await call("add_product", { sku: p.sku, name: p.name, unit_price: p.unit_price, reorder_level: p.reorder_level });
  await call("receive_stock", { sku: p.sku, qty: p.qty, unit_cost: p.cost, date: daysAgo(80) });
}

console.log("Onboarding clients (one left incomplete on purpose)...");
const approved = ["Harbor Steelworks", "Northgate Logistics", "Brightfield Foods"];
for (const name of approved) {
  await call("create_client", { name, email: `accounts@${name.toLowerCase().replace(/[^a-z]/g, "")}.example` });
  for (const doc of ["business_registration", "tax_id", "authorized_signatory"]) {
    await call("update_client_document", { client: name, doc_type: doc, status: "approved" });
  }
}
await call("create_client", { name: "Kestrel Packaging", email: "hello@kestrelpackaging.example" });
await call("update_client_document", { client: "Kestrel Packaging", doc_type: "business_registration", status: "approved" });
await call("update_client_document", { client: "Kestrel Packaging", doc_type: "tax_id", status: "received" });

console.log("Selling, invoicing and collecting...");
async function sell(client, items, daysBack, terms, paidShare) {
  const order = await call("create_order", { client, items });
  const { invoice } = await call("fulfill_order", { order_id: order.order_id, terms_days: terms, date: daysAgo(daysBack) });
  if (paidShare > 0) {
    await call("record_payment", { invoice: invoice.number, amount: Math.round(invoice.total * paidShare * 100) / 100, method: "bank transfer", date: daysAgo(Math.max(daysBack - 12, 0)) });
  }
  return invoice;
}
await sell("Harbor Steelworks", [{ sku: "PAL-100", qty: 40 }, { sku: "TAPE-48", qty: 60 }], 70, 30, 1); // paid
await sell("Northgate Logistics", [{ sku: "BOX-M", qty: 400 }, { sku: "LBL-A5", qty: 20 }], 55, 30, 0.5); // partly paid, overdue
await sell("Brightfield Foods", [{ sku: "GLV-L", qty: 90 }, { sku: "BOX-M", qty: 300 }], 40, 30, 0); // overdue, unpaid
await sell("Harbor Steelworks", [{ sku: "LBL-A5", qty: 15 }], 20, 30, 0); // current
await sell("Northgate Logistics", [{ sku: "PAL-100", qty: 25 }], 6, 30, 0); // current
await call("create_order", { client: "Brightfield Foods", items: [{ sku: "TAPE-48", qty: 50 }] }); // waiting to ship
await call("create_invoice", {
  client: "Harbor Steelworks",
  items: [{ description: "Warehouse packing audit", qty: 1, unit_price: 1200 }],
  issue_date: daysAgo(35),
  terms_days: 15,
}); // services invoice, long overdue

console.log("Recording expenses...");
await call("record_expense", { description: "Warehouse rent", amount: 2400, account_code: "6100", date: daysAgo(60) });
await call("record_expense", { description: "Warehouse rent", amount: 2400, account_code: "6100", date: daysAgo(30) });
await call("record_expense", { description: "Accounting software", amount: 89, account_code: "6200", date: daysAgo(15) });
await call("record_expense", { description: "Courier charges (unpaid bill)", amount: 310, paid_from: "payable", date: daysAgo(10) });

const d = await call("get_dashboard");
const tb = await call("get_trial_balance");
console.log(`\nDone. Cash ${d.cash}, receivables ${d.accounts_receivable} (overdue ${d.overdue_invoices.amount}), inventory ${d.inventory_value}, low stock items ${d.low_stock_products}. Books balanced: ${tb.balanced}`);
