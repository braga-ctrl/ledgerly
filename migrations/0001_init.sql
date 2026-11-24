-- Ledgerly schema. All money is stored as integer minor units (cents).

CREATE TABLE orgs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  invoice_seq INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE api_keys (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs(id),
  key_hash   TEXT NOT NULL UNIQUE,
  label      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Chart of accounts
CREATE TABLE accounts (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  code   TEXT NOT NULL,
  name   TEXT NOT NULL,
  type   TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  PRIMARY KEY (org_id, code)
);

CREATE TABLE journal_entries (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs(id),
  date       TEXT NOT NULL,
  memo       TEXT NOT NULL,
  ref_type   TEXT,
  ref_id     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE journal_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id     TEXT NOT NULL REFERENCES journal_entries(id),
  org_id       TEXT NOT NULL,
  account_code TEXT NOT NULL,
  debit        INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit       INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0)
);
CREATE INDEX idx_lines_org_account ON journal_lines(org_id, account_code);

-- Client onboarding
CREATE TABLE clients (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs(id),
  name       TEXT NOT NULL,
  email      TEXT,
  status     TEXT NOT NULL DEFAULT 'documents_pending'
             CHECK (status IN ('documents_pending','under_review','approved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_clients_org ON clients(org_id);

CREATE TABLE client_documents (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  client_id  TEXT NOT NULL REFERENCES clients(id),
  doc_type   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'requested'
             CHECK (status IN ('requested','received','approved','rejected')),
  note       TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, doc_type)
);

-- Inventory
CREATE TABLE products (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  sku           TEXT NOT NULL,
  name          TEXT NOT NULL,
  unit_price    INTEGER NOT NULL CHECK (unit_price >= 0),
  unit_cost     INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  stock_qty     INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  reorder_level INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (org_id, sku)
);

CREATE TABLE stock_movements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id     TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  qty_change INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  ref_id     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Orders
CREATE TABLE orders (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs(id),
  client_id  TEXT NOT NULL REFERENCES clients(id),
  status     TEXT NOT NULL DEFAULT 'confirmed'
             CHECK (status IN ('confirmed','fulfilled','cancelled')),
  invoice_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_orders_org ON orders(org_id);

CREATE TABLE order_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  qty        INTEGER NOT NULL CHECK (qty > 0),
  unit_price INTEGER NOT NULL
);

-- Invoices & payments
CREATE TABLE invoices (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs(id),
  number     TEXT NOT NULL,
  client_id  TEXT NOT NULL REFERENCES clients(id),
  order_id   TEXT,
  issue_date TEXT NOT NULL,
  due_date   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','paid','void')),
  total      INTEGER NOT NULL CHECK (total >= 0),
  paid       INTEGER NOT NULL DEFAULT 0 CHECK (paid >= 0),
  CHECK (paid <= total),
  UNIQUE (org_id, number)
);
CREATE INDEX idx_invoices_org ON invoices(org_id);
-- One invoice per fulfilled order; also stops a double-click from fulfilling an order twice.
CREATE UNIQUE INDEX idx_invoices_order ON invoices(order_id) WHERE order_id IS NOT NULL;

CREATE TABLE invoice_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  TEXT NOT NULL REFERENCES invoices(id),
  description TEXT NOT NULL,
  qty         INTEGER NOT NULL CHECK (qty > 0),
  unit_price  INTEGER NOT NULL CHECK (unit_price >= 0)
);

CREATE TABLE payments (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  amount     INTEGER NOT NULL CHECK (amount > 0),
  method     TEXT,
  date       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
