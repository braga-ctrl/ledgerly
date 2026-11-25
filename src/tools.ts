import * as svc from "./services";
import type { Args, Ctx } from "./util";

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** true = only reads data (used for MCP annotations and the UI) */
  readOnly: boolean;
  /** true = cancels or reverses something that cannot simply be re-created (MCP destructiveHint) */
  destructive?: boolean;
  run: (ctx: Ctx, args: Args) => Promise<unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const num = (description: string) => ({ type: "number", description });
const int = (description: string) => ({ type: "integer", description });
const date = (description: string) => str(description + " (YYYY-MM-DD)", { format: "date" });

export const tools: Tool[] = [
  // ---- overview ----------------------------------------------------------
  {
    name: "get_dashboard",
    title: "Business dashboard",
    description:
      "Snapshot of the business: cash, receivables, payables, client credits, inventory value, open and overdue invoices, this month's revenue/expenses/net income, low-stock count, orders awaiting fulfilment, clients by onboarding status (with how long each unapproved client has waited and which documents block them), and a list of warnings such as negative cash. Start here for 'how are we doing?', and always mention any warnings.",
    inputSchema: obj({}),
    readOnly: true,
    run: (c) => svc.dashboard(c),
  },

  // ---- client onboarding -------------------------------------------------
  {
    name: "create_client",
    title: "Create client",
    description:
      "Add a business client and start onboarding. The client is created with the required document checklist (business registration, tax ID, authorized signatory) and cannot place orders or be invoiced until every document is approved.",
    inputSchema: obj({ name: str("Legal or trading name of the client business"), email: str("Primary contact email") }, ["name"]),
    readOnly: false,
    run: svc.createClient,
  },
  {
    name: "list_clients",
    title: "List clients",
    description:
      "List clients with their onboarding status, how many days each unapproved client has been waiting, which documents are blocking approval (and whether the client or a reviewer is the one to act), and any credit held for the client.",
    inputSchema: obj({ status: str("Filter by status", { enum: ["documents_pending", "under_review", "approved"] }) }),
    readOnly: true,
    run: svc.listClients,
  },
  {
    name: "get_client",
    title: "Get client",
    description: "One client with the status of every onboarding document.",
    inputSchema: obj({ client: str("Client id or exact client name") }, ["client"]),
    readOnly: true,
    run: svc.getClient,
  },
  {
    name: "update_client_document",
    title: "Update onboarding document",
    description:
      "Move a client's onboarding document through its workflow: received (client sent it), approved (checked and accepted), rejected (sent back for resubmission), or requested (ask for an extra document by using a new doc_type). When every document is approved the client becomes approved automatically.",
    inputSchema: obj(
      {
        client: str("Client id or exact client name"),
        doc_type: str("Document type, e.g. business_registration, tax_id, authorized_signatory, or a new one"),
        status: str("New status", { enum: ["requested", "received", "approved", "rejected"] }),
        note: str("Optional reviewer note"),
      },
      ["client", "doc_type", "status"],
    ),
    readOnly: false,
    run: svc.updateClientDocument,
  },
  {
    name: "update_client",
    title: "Edit client details",
    description:
      "Change a client's name or contact email. Onboarding status cannot be edited here (it follows the documents). Every change is written to the audit log. Pass an empty email to clear it.",
    inputSchema: obj(
      { client: str("Client id or exact client name"), name: str("New name"), email: str("New contact email (empty string clears it)") },
      ["client"],
    ),
    readOnly: false,
    run: svc.updateClient,
  },

  // ---- inventory ---------------------------------------------------------
  {
    name: "add_product",
    title: "Add product",
    description:
      "Create a product in the catalogue. Stock starts at zero: use receive_stock to bring inventory in. Ask the user for the reorder level before calling: it is the stock level at which they want a low-stock warning (0 only warns once the product is already out of stock).",
    inputSchema: obj(
      {
        sku: str("Unique stock keeping unit code"),
        name: str("Product name"),
        unit_price: num("Selling price per unit"),
        reorder_level: int("Flag as low stock when on-hand quantity is at or below this number. 0 means only flag it once it is out of stock."),
        unit_cost: num("Initial cost per unit (optional; receive_stock keeps a weighted average)"),
      },
      ["sku", "name", "unit_price", "reorder_level"],
    ),
    readOnly: false,
    run: svc.addProduct,
  },
  {
    name: "update_product",
    title: "Edit product",
    description:
      "Change a product's name, selling price or reorder level. Cost and stock cannot be edited here (cost changes through receive_stock). A new price applies to future orders only: existing orders and invoices keep the price they were made at. Every change is written to the audit log.",
    inputSchema: obj(
      { sku: str("Product SKU"), name: str("New product name"), unit_price: num("New selling price per unit"), reorder_level: int("New low-stock threshold") },
      ["sku"],
    ),
    readOnly: false,
    run: svc.updateProduct,
  },
  {
    name: "list_products",
    title: "List products",
    description: "Catalogue with price, average cost, stock on hand, stock value and low-stock flag.",
    inputSchema: obj({ search: str("Match against SKU or name") }),
    readOnly: true,
    run: svc.listProducts,
  },
  {
    name: "receive_stock",
    title: "Receive stock",
    description:
      "Record stock received from a supplier. Updates quantity and weighted-average cost, and posts Dr Inventory / Cr Cash (or Cr Accounts Payable when on_credit is true). A cash receipt is subject to the workspace cash policy: it can come back with a warning, or be refused, if it would take cash below zero. Then record owner funding or receive on credit instead.",
    inputSchema: obj(
      {
        sku: str("Product SKU"),
        qty: int("Units received"),
        unit_cost: num("Cost per unit paid to the supplier"),
        on_credit: { type: "boolean", description: "True if not paid yet (books to Accounts Payable)" },
        date: date("Receipt date, defaults to today"),
      },
      ["sku", "qty", "unit_cost"],
    ),
    readOnly: false,
    run: svc.receiveStock,
  },
  {
    name: "get_low_stock",
    title: "Low-stock report",
    description: "Products at or below their reorder level.",
    inputSchema: obj({}),
    readOnly: true,
    run: (c) => svc.lowStock(c),
  },

  // ---- orders ------------------------------------------------------------
  {
    name: "create_order",
    title: "Create order",
    description:
      "Create a sales order for an approved client. Stock is reserved (checked against on-hand minus other open orders) at the current catalogue price. Use fulfill_order to ship and invoice it.",
    inputSchema: obj(
      {
        client: str("Client id or exact client name"),
        items: {
          type: "array",
          minItems: 1,
          description: "Order lines",
          items: obj({ sku: str("Product SKU"), qty: int("Quantity") }, ["sku", "qty"]),
        },
      },
      ["client", "items"],
    ),
    readOnly: false,
    run: svc.createOrder,
  },
  {
    name: "list_orders",
    title: "List orders",
    description: "Recent orders with lines and totals.",
    inputSchema: obj({ status: str("Filter by status", { enum: ["confirmed", "fulfilled", "cancelled"] }) }),
    readOnly: true,
    run: svc.listOrders,
  },
  {
    name: "get_order",
    title: "Get order",
    description: "One order with its lines and total.",
    inputSchema: obj({ order_id: str("Order id") }, ["order_id"]),
    readOnly: true,
    run: svc.getOrder,
  },
  {
    name: "cancel_order",
    title: "Cancel order",
    description: "Cancel a confirmed order that has not been fulfilled; releases the reserved stock.",
    inputSchema: obj({ order_id: str("Order id") }, ["order_id"]),
    readOnly: false,
    destructive: true,
    run: svc.cancelOrder,
  },
  {
    name: "fulfill_order",
    title: "Fulfil order and invoice",
    description:
      "Ship a confirmed order: reduces stock, creates the invoice, and posts both entries (Dr Cost of Goods Sold / Cr Inventory at average cost, and Dr Accounts Receivable / Cr Sales Revenue). Returns the order and the new invoice.",
    inputSchema: obj(
      { order_id: str("Order id"), terms_days: int("Payment terms in days, default 30"), date: date("Invoice date, defaults to today") },
      ["order_id"],
    ),
    readOnly: false,
    run: svc.fulfillOrder,
  },

  // ---- invoices & payments -----------------------------------------------
  {
    name: "create_invoice",
    title: "Create invoice",
    description:
      "Issue a free-form invoice (services, fees, anything not tied to stock) to an approved client. Posts Dr Accounts Receivable / Cr Sales Revenue. For stock sales use create_order then fulfill_order.",
    inputSchema: obj(
      {
        client: str("Client id or exact client name"),
        items: {
          type: "array",
          minItems: 1,
          description: "Invoice lines",
          items: obj({ description: str("What is being billed"), qty: int("Quantity"), unit_price: num("Price per unit") }, ["description", "qty", "unit_price"]),
        },
        terms_days: int("Payment terms in days, default 30"),
        issue_date: date("Issue date, defaults to today"),
      },
      ["client", "items"],
    ),
    readOnly: false,
    run: svc.createInvoice,
  },
  {
    name: "list_invoices",
    title: "List invoices",
    description: "Invoices with totals, paid and credited amounts, balances and overdue flags.",
    inputSchema: obj({
      status: str("Filter by status (credited = settled entirely by credit notes)", { enum: ["open", "partial", "paid", "credited", "void"] }),
      client: str("Client id or exact name"),
      overdue_only: { type: "boolean", description: "Only unpaid invoices past their due date" },
    }),
    readOnly: true,
    run: svc.listInvoices,
  },
  {
    name: "get_invoice",
    title: "Get invoice",
    description: "One invoice with its numbered line items, payment history and any credit notes issued against it.",
    inputSchema: obj({ invoice: str("Invoice id or number, e.g. INV-00001") }, ["invoice"]),
    readOnly: true,
    run: svc.getInvoice,
  },
  {
    name: "record_payment",
    title: "Record payment",
    description: "Record money received against an invoice (full or partial). Posts Dr Cash / Cr Accounts Receivable and updates the invoice status. Overpayment is rejected.",
    inputSchema: obj(
      { invoice: str("Invoice id or number"), amount: num("Amount received"), method: str("e.g. bank transfer, cheque, cash"), date: date("Payment date, defaults to today") },
      ["invoice", "amount"],
    ),
    readOnly: false,
    run: svc.recordPayment,
  },
  {
    name: "void_invoice",
    title: "Void invoice",
    description:
      "Void an unpaid free-form invoice and reverse its entry. Not allowed for invoices with payments or credit notes, or invoices created from fulfilled orders: use issue_credit_note for those.",
    inputSchema: obj({ invoice: str("Invoice id or number") }, ["invoice"]),
    readOnly: false,
    destructive: true,
    run: svc.voidInvoice,
  },
  {
    name: "issue_credit_note",
    title: "Issue credit note",
    description:
      "Correct an invoice that is fulfilled or paid, in full or in part, without editing it. Pick lines by their number on the invoice (get_invoice) and a quantity; leave items out to credit everything not yet credited. What the client still owed is reduced (Dr Sales Revenue / Cr Accounts Receivable); any excess, money they already paid, becomes a client credit (Cr Customer Credits). For stock lines you must say whether the goods came back: return_stock true puts them back into stock at their original cost (Dr Inventory / Cr Cost of Goods Sold), false credits the money only. Needs a reason. Cannot be undone.",
    inputSchema: obj(
      {
        invoice: str("Invoice id or number, e.g. INV-00001"),
        reason: str("Why the credit is being given, e.g. damaged in transit"),
        items: {
          type: "array",
          minItems: 1,
          description: "Lines to credit; omit to credit everything not yet credited",
          items: obj({ line: int("Line number on the invoice, starting at 1"), qty: int("Units to credit") }, ["line", "qty"]),
        },
        return_stock: { type: "boolean", description: "Required when any credited line is a stock item: true if the goods came back into stock, false to credit the money only" },
        date: date("Credit note date, defaults to today"),
      },
      ["invoice", "reason"],
    ),
    readOnly: false,
    destructive: true,
    run: svc.issueCreditNote,
  },

  // ---- general accounting ------------------------------------------------
  {
    name: "record_owner_investment",
    title: "Record owner investment",
    description:
      "Record money put into the business by the owner (Dr Cash / Cr Owner's Equity). Use it to set opening cash, or to cover cash that went out before it was put in (the dashboard warns when cash is negative).",
    inputSchema: obj({ amount: num("Amount invested"), memo: str("Description"), date: date("Date, defaults to today") }, ["amount"]),
    readOnly: false,
    run: svc.recordOwnerInvestment,
  },
  {
    name: "record_expense",
    title: "Record expense",
    description:
      "Record a business expense. Debits an expense account (default 6000 Operating Expenses) and credits Cash, or Accounts Payable when paid_from is 'payable'. A cash expense is subject to the workspace cash policy and may come back with a warning, or be refused, if it would take cash below zero.",
    inputSchema: obj(
      {
        description: str("What the expense was for"),
        amount: num("Amount"),
        account_code: str("Expense account code, default 6000. See list_accounts."),
        paid_from: str("'cash' (default) or 'payable' if the bill is not paid yet", { enum: ["cash", "payable"] }),
        date: date("Expense date, defaults to today"),
      },
      ["description", "amount"],
    ),
    readOnly: false,
    run: svc.recordExpense,
  },
  {
    name: "pay_supplier",
    title: "Pay supplier",
    description: "Settle money owed to suppliers (Dr Accounts Payable / Cr Cash). Cannot exceed what is owed. Subject to the workspace cash policy if it would take cash below zero.",
    inputSchema: obj({ amount: num("Amount paid"), memo: str("Description"), date: date("Payment date, defaults to today") }, ["amount"]),
    readOnly: false,
    run: svc.paySupplier,
  },
  {
    name: "list_accounts",
    title: "Chart of accounts",
    description: "The chart of accounts (code, name, type).",
    inputSchema: obj({}),
    readOnly: true,
    run: (c) => svc.listAccounts(c),
  },
  {
    name: "add_account",
    title: "Add account",
    description: "Add an account to the chart of accounts, e.g. 6100 Rent (expense).",
    inputSchema: obj(
      { code: str("3 to 6 digits"), name: str("Account name"), type: str("Account type", { enum: ["asset", "liability", "equity", "revenue", "expense"] }) },
      ["code", "name", "type"],
    ),
    readOnly: false,
    run: svc.addAccount,
  },
  {
    name: "get_journal",
    title: "Journal entries",
    description:
      "Most recent double-entry journal entries with their ids, debit and credit lines, for audit. A reversed entry shows reversed_by, and a reversing entry shows what it reverses and why.",
    inputSchema: obj({ limit: int("How many entries, default 20, max 100") }),
    readOnly: true,
    run: svc.getJournal,
  },
  {
    name: "reverse_journal_entry",
    title: "Reverse journal entry",
    description:
      "Correct a posted journal entry without editing it: posts a new entry that mirrors it with debits and credits swapped, linked to the original, with a required reason. The original stays visible and unchanged, and an entry can be reversed only once. Entries that belong to an invoice, payment, stock receipt, shipped order or credit note are refused (they would put the invoice or stock out of step with the books): use void_invoice or issue_credit_note for those. Get entry ids from get_journal.",
    inputSchema: obj(
      { entry_id: str("Journal entry id from get_journal"), reason: str("Why it is being reversed"), date: date("Date of the reversing entry, defaults to today") },
      ["entry_id", "reason"],
    ),
    readOnly: false,
    destructive: true,
    run: svc.reverseJournalEntry,
  },
  {
    name: "get_audit_log",
    title: "Audit log",
    description:
      "The append-only record of edits and corrections (product and client edits, setting changes, reversals, credit notes), newest first, with what changed. Filter by entity type (product, client, settings, journal_entry, credit_note) or entity id.",
    inputSchema: obj({
      entity_type: str("Filter by what was changed", { enum: ["product", "client", "settings", "journal_entry", "credit_note"] }),
      entity_id: str("Filter to one product, client, entry or credit note id"),
      limit: int("How many entries, default 50, max 200"),
    }),
    readOnly: true,
    run: svc.getAuditLog,
  },
  {
    name: "get_settings",
    title: "Workspace settings",
    description: "The workspace settings. Currently the cash policy: block (refuse cash payments that would take cash below zero), warn (allow them but return a warning) or allow.",
    inputSchema: obj({}),
    readOnly: true,
    run: (c) => svc.getSettings(c),
  },
  {
    name: "update_settings",
    title: "Change workspace settings",
    description: "Change the cash policy: block, warn (the default) or allow. The change is written to the audit log.",
    inputSchema: obj({ cash_policy: str("What to do with a cash payment that would take cash below zero", { enum: ["block", "warn", "allow"] }) }, ["cash_policy"]),
    readOnly: false,
    run: svc.updateSettings,
  },

  // ---- reports -----------------------------------------------------------
  {
    name: "get_trial_balance",
    title: "Trial balance",
    description: "Debit and credit balance of every account as of a date, with a check that total debits equal total credits.",
    inputSchema: obj({ as_of: date("Report date, defaults to today") }),
    readOnly: true,
    run: svc.trialBalance,
  },
  {
    name: "get_profit_and_loss",
    title: "Profit and loss",
    description: "Revenue, expenses, gross profit and net income for a period (defaults to the current month).",
    inputSchema: obj({ from: date("Start date"), to: date("End date") }),
    readOnly: true,
    run: svc.profitAndLoss,
  },
  {
    name: "get_ar_aging",
    title: "Receivables aging",
    description: "Unpaid invoices grouped into current, 1-30, 31-60, 61-90 and 90+ days overdue, in total and per client.",
    inputSchema: obj({}),
    readOnly: true,
    run: (c) => svc.arAging(c),
  },
];

export const toolIndex = new Map(tools.map((t) => [t.name, t]));
