---
name: month-end-review
description: Review the health of the business in Ledgerly: who owes money, whether the books balance, profit and loss, and low stock. Use for questions like how are we doing, month-end close, who has not paid us, what is our profit this month, or is everything balanced.
---

Use the Ledgerly connector. Report only what the data returns; do not estimate or fill gaps.

## Quick health check

Call `get_dashboard` and summarize in a few lines: cash, receivables, overdue amount, payables, this month's revenue, expenses and net income, plus anything needing attention (overdue invoices, low stock, orders waiting to ship, clients stuck in onboarding).

## Month-end close

Work through these in order and stop to tell the user if any check fails:

1. `get_trial_balance`: confirm `balanced` is true. If it is not, say so first and show the totals; do not continue as if the books were fine.
2. `get_profit_and_loss` with `from` and `to` for the month: revenue, cost of goods sold, gross profit, expenses, net income.
3. `get_ar_aging`: list clients with balances past 30 days, largest first.
4. `get_low_stock`: list products at or below their reorder level.
5. `get_journal` if the user wants to audit something specific.

## Chasing late payers

For each overdue invoice, offer to draft a short, polite reminder with the invoice number, amount, due date and days overdue. Draft the text for the user to send. Do not claim to have sent anything.

## Be careful about

- Ledgerly records transactions; it does not file taxes or give tax or legal advice. If asked, say so and suggest an accountant.
- The profit and loss defaults to the current month. If the user says "last month" or "this quarter", pass explicit dates.
- Voided invoices and fully paid invoices do not appear in aging.
