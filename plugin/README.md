# Ledgerly

Ledgerly lets Claude run the back office of a business that sells to other businesses. It covers three jobs in one place: onboarding new clients, selling stock and invoicing it, and keeping a double-entry set of books that updates itself.

## What you can ask Claude to do

- **Onboard clients.** Add a client, track the documents they owe you (business registration, tax ID, authorized signatory), and approve or reject each one. A client cannot be sold to or invoiced until onboarding is complete.
- **Sell and invoice.** Create an order for an approved client, check stock before promising it, ship it, and get the invoice in one step. Record full or partial payments as money arrives.
- **Manage inventory.** Add products, receive stock from suppliers (cost is averaged for you), and see what is running low.
- **Keep the books.** Every sale, payment, purchase and expense posts a balanced journal entry. Ask for the trial balance, profit and loss, receivables aging, or the raw journal.

Three skills ship with the plugin and teach Claude the right order of steps: `onboard-client`, `order-to-cash` and `month-end-review`.

## Set up

1. Install the plugin. In Claude Code, run:

   ```
   /plugin install ledgerly --marketplace braga-ctrl/ledgerly
   ```

   On claude.ai, add it from Customize > Plugins instead.
2. Connect the **Ledgerly** connector from the plugin's Connectors tab (or run `/mcp` in Claude Code). When the sign-in page opens, paste your company's workspace API key and approve. Each company workspace has its own key and sees only its own data.
3. Ask something like "How are we doing this month?" to start.

## Data

Everything you ask Claude to record or look up is sent to the Ledgerly server at <!--host-->ledgerly.example.workers.dev<!--/host--> and stored in that server's database: client names and emails, product and price lists, orders, invoices, payments and journal entries. The plugin itself stores nothing and sends data nowhere else. Sign-in uses OAuth 2.0 with PKCE; Claude receives a short-lived access token, never your workspace key.

## License

MIT. See `LICENSE`.
