import { HttpError, uid } from "./util";

export const ACCOUNT = {
  CASH: "1000",
  AR: "1100",
  INVENTORY: "1200",
  AP: "2000",
  CUSTOMER_CREDITS: "2100",
  EQUITY: "3000",
  REVENUE: "4000",
  COGS: "5000",
  OPEX: "6000",
} as const;

export const DEFAULT_ACCOUNTS: { code: string; name: string; type: string }[] = [
  { code: ACCOUNT.CASH, name: "Cash and Bank", type: "asset" },
  { code: ACCOUNT.AR, name: "Accounts Receivable", type: "asset" },
  { code: ACCOUNT.INVENTORY, name: "Inventory", type: "asset" },
  { code: ACCOUNT.AP, name: "Accounts Payable", type: "liability" },
  { code: ACCOUNT.CUSTOMER_CREDITS, name: "Customer Credits", type: "liability" },
  { code: ACCOUNT.EQUITY, name: "Owner's Equity", type: "equity" },
  { code: ACCOUNT.REVENUE, name: "Sales Revenue", type: "revenue" },
  { code: ACCOUNT.COGS, name: "Cost of Goods Sold", type: "expense" },
  { code: ACCOUNT.OPEX, name: "Operating Expenses", type: "expense" },
];

export interface JournalLine {
  account: string;
  debit?: number; // cents
  credit?: number; // cents
}

/**
 * Build the prepared statements for one balanced journal entry. They are returned
 * (not executed) so callers can put them in the same D1 batch (= one transaction)
 * as the business change that caused them.
 */
export function journalStatements(
  db: D1Database,
  orgId: string,
  entry: { date: string; memo: string; refType?: string; refId?: string; lines: JournalLine[] },
): D1PreparedStatement[] {
  const lines = entry.lines.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
  const debit = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const credit = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (lines.length < 2 || debit !== credit) {
    throw new HttpError(500, `Unbalanced journal entry "${entry.memo}" (debit ${debit} vs credit ${credit})`);
  }
  const id = uid();
  return [
    db
      .prepare("INSERT INTO journal_entries (id, org_id, date, memo, ref_type, ref_id) VALUES (?,?,?,?,?,?)")
      .bind(id, orgId, entry.date, entry.memo, entry.refType ?? null, entry.refId ?? null),
    ...lines.map((l) =>
      db
        .prepare("INSERT INTO journal_lines (entry_id, org_id, account_code, debit, credit) VALUES (?,?,?,?,?)")
        .bind(id, orgId, l.account, l.debit ?? 0, l.credit ?? 0),
    ),
  ];
}
