-- Sprint 1 (Phase 0): ledger correctness and trust.
--   P0-1 cash policy + atomic cash guard      P0-3 audit trail for edits
--   P0-4 linked reversing entries             P0-5 credit notes and stock returns
-- Additive only: 0001 and 0002 are untouched. Money is integer cents.

-- ---------------------------------------------------------------------------
-- P0-1: per-workspace settings. No row means the defaults (cash_policy = 'warn').
-- ---------------------------------------------------------------------------
CREATE TABLE org_settings (
  org_id      TEXT PRIMARY KEY REFERENCES orgs(id),
  cash_policy TEXT NOT NULL DEFAULT 'warn' CHECK (cash_policy IN ('block','warn','allow')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A scratch table used as a tripwire inside a D1 batch: when the cash policy is 'block', the
-- batch inserts a row whose "ok" is 0 if cash would end up negative. That violates the CHECK,
-- and the whole batch (business change + journal entry) rolls back. Rows are deleted in the
-- same batch, so the table stays empty.
CREATE TABLE cash_guard (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ok INTEGER NOT NULL CHECK (ok = 1)
);

-- ---------------------------------------------------------------------------
-- P0-3: append-only audit trail. Updates and deletes are rejected by the database itself.
-- "actor" is a placeholder until user accounts exist (backlog P0-7).
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  actor       TEXT NOT NULL DEFAULT 'workspace',
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  detail      TEXT NOT NULL            -- JSON: what changed (before/after) and why
);
CREATE INDEX idx_audit_org ON audit_log(org_id, id);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- ---------------------------------------------------------------------------
-- P0-4: reversing entries. A reversal is a new entry that points at the original.
-- The unique index means an entry can be reversed at most once.
-- ---------------------------------------------------------------------------
ALTER TABLE journal_entries ADD COLUMN reverses_entry_id TEXT REFERENCES journal_entries(id);
ALTER TABLE journal_entries ADD COLUMN reason TEXT;
CREATE UNIQUE INDEX idx_journal_reverses ON journal_entries(reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- P0-5: credit notes and stock returns.
-- ---------------------------------------------------------------------------
ALTER TABLE orgs ADD COLUMN credit_note_seq INTEGER NOT NULL DEFAULT 0;

-- Money a client is owed after a credit note exceeded what they still owed on the invoice.
ALTER TABLE clients ADD COLUMN credit_balance INTEGER NOT NULL DEFAULT 0 CHECK (credit_balance >= 0);

-- Credits applied against an invoice. The database refuses paid + credited > total.
ALTER TABLE invoices ADD COLUMN credited INTEGER NOT NULL DEFAULT 0 CHECK (credited >= 0 AND paid + credited <= total);

-- Invoice lines now remember which product they sold and what it cost, so a return can put the
-- stock back at the original average cost. credited_qty can never exceed the quantity sold.
ALTER TABLE invoice_items ADD COLUMN product_id TEXT REFERENCES products(id);
ALTER TABLE invoice_items ADD COLUMN unit_cost INTEGER;      -- NULL = cost not recorded (older invoices)
ALTER TABLE invoice_items ADD COLUMN credited_qty INTEGER NOT NULL DEFAULT 0 CHECK (credited_qty >= 0 AND credited_qty <= qty);

CREATE TABLE credit_notes (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  number        TEXT NOT NULL,
  invoice_id    TEXT NOT NULL REFERENCES invoices(id),
  client_id     TEXT NOT NULL REFERENCES clients(id),
  date          TEXT NOT NULL,
  reason        TEXT NOT NULL,
  total         INTEGER NOT NULL CHECK (total > 0),
  applied       INTEGER NOT NULL CHECK (applied >= 0),        -- reduced what the client still owed
  client_credit INTEGER NOT NULL CHECK (client_credit >= 0),  -- excess kept as a credit for the client
  stock_returned INTEGER NOT NULL DEFAULT 0 CHECK (stock_returned IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (applied + client_credit = total),
  UNIQUE (org_id, number)
);
CREATE INDEX idx_credit_notes_org ON credit_notes(org_id);
CREATE INDEX idx_credit_notes_invoice ON credit_notes(invoice_id);

CREATE TABLE credit_note_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  credit_note_id  TEXT NOT NULL REFERENCES credit_notes(id),
  invoice_item_id INTEGER NOT NULL REFERENCES invoice_items(id),
  description     TEXT NOT NULL,
  qty             INTEGER NOT NULL CHECK (qty > 0),
  unit_price      INTEGER NOT NULL CHECK (unit_price >= 0),
  product_id      TEXT REFERENCES products(id),
  unit_cost       INTEGER                                        -- set only when the stock was returned
);

-- Liability account for client credits. Existing workspaces get it here; new ones from DEFAULT_ACCOUNTS.
INSERT INTO accounts (org_id, code, name, type)
SELECT id, '2100', 'Customer Credits', 'liability' FROM orgs
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = orgs.id AND a.code = '2100');

-- Backfill for invoices that were created before this migration (best effort, never guesses):
-- 1) link order-invoice lines to their product by the "Name (SKU)" description they were created with
UPDATE invoice_items SET product_id = (
  SELECT oi.product_id
  FROM invoices i
  JOIN order_items oi ON oi.order_id = i.order_id
  JOIN products p ON p.id = oi.product_id
  WHERE i.id = invoice_items.invoice_id
    AND invoice_items.description = p.name || ' (' || p.sku || ')'
  LIMIT 1
);

-- 2) the cost per unit is only recoverable exactly when the order had a single line: the whole
--    cost-of-goods-sold entry belongs to that line. Multi-line orders stay NULL, and returning
--    their stock is refused with a clear message (money-only credit notes still work).
UPDATE invoice_items SET unit_cost = (
  SELECT jl.debit / invoice_items.qty
  FROM invoices i
  JOIN journal_entries je ON je.org_id = i.org_id AND je.ref_type = 'order' AND je.ref_id = i.order_id
  JOIN journal_lines jl ON jl.entry_id = je.id AND jl.account_code = '5000'
  WHERE i.id = invoice_items.invoice_id
)
WHERE product_id IS NOT NULL
  AND (SELECT COUNT(*) FROM invoice_items ii WHERE ii.invoice_id = invoice_items.invoice_id) = 1;
