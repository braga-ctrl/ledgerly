---
name: order-to-cash
description: Sell stock to an approved client, ship and invoice it, record the payment, and correct an invoice with a credit note in Ledgerly. Use when the user wants to create an order, fulfil or ship one, invoice a client, record a payment received, issue a credit note or take returned goods back, receive stock from a supplier, change a product's price, or check what is in stock.
---

Use the Ledgerly connector. Money is always a plain decimal number in the workspace currency, for example 1250.50.

## Selling stock

1. Confirm the client is approved. If `create_order` says they are not, switch to the `onboard-client` skill.
2. Call `list_products` to check the SKUs, prices and stock. Say plainly if something is short: orders reserve stock, so available quantity is on-hand minus stock held by other open orders.
3. Call `create_order` with `client` and `items` (`sku` and `qty`). The price is the current catalogue price. Show the user the lines and total.
4. Ask the user to confirm before shipping. Then call `fulfill_order`. This one step reduces stock, creates the invoice, and posts the cost of goods sold and the receivable. Use `terms_days` if the user names payment terms (default 30).
5. Report the invoice number, total and due date.

An order can be cancelled with `cancel_order` only before it is fulfilled.

## Invoicing something that is not stock

For services or fees, call `create_invoice` with free-form `items` (`description`, `qty`, `unit_price`). An unpaid free-form invoice can be reversed with `void_invoice`.

## Getting paid

Call `record_payment` with the invoice number, the `amount` actually received, and the `method` and `date` if the user gave them. Partial payments are fine. Ledgerly rejects overpayment, so if the user says they received more than the balance, point out the difference instead of retrying.

Do not invent amounts or dates. If the user says "they paid", ask how much.

## Correcting an invoice: credit notes

An invoice from a fulfilled order, or one that has been paid, cannot be voided or edited. Correct it with `issue_credit_note`:

1. Call `get_invoice` and read the numbered lines. Work out which lines, and how many units of each, are being credited. Leave `items` out only if the user wants the whole invoice credited.
2. Ask for the `reason` if the user has not given one; it is required.
3. For stock items, ask whether the goods actually came back. `return_stock: true` puts them back into stock at the cost they were sold at; `false` credits the money only (a refund without the goods, or a price concession). Never guess this.
4. Credit notes cannot be undone, so state what you are about to credit and get a yes first.
5. Report the credit note number, the total, how much reduced what the client still owes, and how much became a credit held for the client (the part they had already paid). A credit held for a client is shown by `get_client` and the dashboard.

If Ledgerly says the original cost of an older invoice was not recorded, offer `return_stock: false` and explain the stock will not be put back automatically.

## Changing a product

Use `update_product` for a name, price or reorder level. A new price applies to new orders only; existing orders and invoices keep the price they were made at, so say so. Cost cannot be edited: it changes only when stock is received.

## Restocking

Call `receive_stock` with `sku`, `qty` and the supplier's `unit_cost`. Set `on_credit` to true if the bill is not paid yet; later settle it with `pay_supplier`. Ledgerly keeps a weighted-average cost, so a second delivery at a different price changes the average.

When adding a product with `add_product`, ask the user for its reorder level (the stock level where they want a low-stock warning) instead of choosing one for them. 0 only warns once it is out of stock.

## When cash would go negative

Cash payments (stock bought for cash, cash expenses, supplier payments) follow the workspace cash policy. If the result carries `warnings`, tell the user in plain words and offer the fixes it names: record owner funding with `record_owner_investment`, or receive on credit / record the expense as payable. If the call is refused because of the cash policy, do not retry with changed numbers or change the policy yourself: explain the options. `get_settings` shows the policy and `update_settings` changes it, but only when the user asks.

## Always finish with

The invoice or order number, the amount, and what is still open (for example "INV-00012: 250.00 still unpaid, due 2026-12-24").
