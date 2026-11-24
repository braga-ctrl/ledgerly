---
name: order-to-cash
description: Sell stock to an approved client, ship and invoice it, and record the payment in Ledgerly. Use when the user wants to create an order, fulfil or ship one, invoice a client, record a payment received, receive stock from a supplier, or check what is in stock.
---

Use the Ledgerly connector. Money is always a plain decimal number in the workspace currency, for example 1250.50.

## Selling stock

1. Confirm the client is approved. If `create_order` says they are not, switch to the `onboard-client` skill.
2. Call `list_products` to check the SKUs, prices and stock. Say plainly if something is short: orders reserve stock, so available quantity is on-hand minus stock held by other open orders.
3. Call `create_order` with `client` and `items` (`sku` and `qty`). The price is the current catalogue price. Show the user the lines and total.
4. Ask the user to confirm before shipping. Then call `fulfill_order`. This one step reduces stock, creates the invoice, and posts the cost of goods sold and the receivable. Use `terms_days` if the user names payment terms (default 30).
5. Report the invoice number, total and due date.

An order can be cancelled with `cancel_order` only before it is fulfilled. An invoice made from an order cannot be voided: if something was wrong, tell the user to issue a correcting invoice.

## Invoicing something that is not stock

For services or fees, call `create_invoice` with free-form `items` (`description`, `qty`, `unit_price`). An unpaid free-form invoice can be reversed with `void_invoice`.

## Getting paid

Call `record_payment` with the invoice number, the `amount` actually received, and the `method` and `date` if the user gave them. Partial payments are fine. Ledgerly rejects overpayment, so if the user says they received more than the balance, point out the difference instead of retrying.

Do not invent amounts or dates. If the user says "they paid", ask how much.

## Restocking

Call `receive_stock` with `sku`, `qty` and the supplier's `unit_cost`. Set `on_credit` to true if the bill is not paid yet; later settle it with `pay_supplier`. Ledgerly keeps a weighted-average cost, so a second delivery at a different price changes the average.

## Always finish with

The invoice or order number, the amount, and what is still open (for example "INV-00012: 250.00 still unpaid, due 2026-12-24").
