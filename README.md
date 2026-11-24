# Ledgerly

A multi-tenant B2B accounting app that runs on Cloudflare Workers, ships with its own MCP server so Claude can operate it, and is packaged as a Claude plugin.

One workspace per company. Inside a workspace:

| Area | What it does |
| --- | --- |
| **Client onboarding** | Required document checklist per client (registration, tax ID, signatory). A client can't be sold to or invoiced until every document is approved. |
| **Orders & inventory** | Product catalogue, stock receipts with weighted-average cost, stock reservation on orders, low-stock report. |
| **Invoicing & payments** | Fulfilling an order ships the stock and creates the invoice in one transaction. Partial payments, overdue tracking, receivables aging. |
| **Double-entry ledger** | Every action above posts a balanced journal entry automatically. Trial balance, profit and loss, journal. |

## How it fits together

```
Claude (chat / Cowork / Claude Code)
   │  OAuth 2.0 + MCP over HTTPS
   ▼
Cloudflare Worker ── src/index.ts ── /mcp         MCP server (Streamable HTTP, stateless)
   │                              ├─ /api/tools/*  same tools as plain JSON (the web UI uses these)
   │                              ├─ /authorize /token /register  OAuth 2.0 server (PKCE, DCR)
   │                              └─ /admin/*      create workspaces, rotate keys (ADMIN_TOKEN)
   ├─ Static assets: public/index.html (web app), public/privacy.html
   └─ D1 (SQLite): migrations/*.sql
```

- `src/services.ts` holds all business logic. Each money-moving action is one D1 batch, so the business change and its journal entry commit together or not at all. Database constraints (`stock >= 0`, `paid <= total`, one invoice per order) back the checks, so concurrent requests can't oversell stock or overpay an invoice.
- `src/tools.ts` is the single tool registry. The MCP server and the REST API both read from it, so they can't drift apart.
- Money is stored as integer cents and crosses the API as decimal numbers.

## Run it locally

```bash
npm install
echo 'ADMIN_TOKEN=local-admin-token' > .dev.vars
npx wrangler d1 migrations apply ledgerly-db --local
npx wrangler dev                      # http://127.0.0.1:8787

# create a workspace and note the api_key it prints
curl -X POST http://127.0.0.1:8787/admin/orgs \
  -H "Authorization: Bearer local-admin-token" -H "Content-Type: application/json" \
  -d '{"name":"My Company"}'

# optional: fill it with demo data
BASE_URL=http://127.0.0.1:8787 API_KEY=lgk_... node scripts/seed-demo.mjs
```

Open http://127.0.0.1:8787, paste the key, and you have the web app.

Run the test suite (134 checks: auth, tenant isolation, onboarding gate, stock reservation, balanced books, concurrency, MCP protocol, full OAuth flow, key rotation):

```bash
ADMIN_TOKEN=local-admin-token node scripts/smoke-test.mjs
```

## Deploy and publish

See **[DEPLOY.md](DEPLOY.md)** for the full path: Cloudflare deploy, plugin configuration, GitHub marketplace, and submission to Anthropic's directory.

## Layout

```
src/            Worker: API, MCP, OAuth, business logic
public/         Web app and privacy policy page (static assets)
migrations/     D1 schema
plugin/         The Claude plugin (manifest, .mcp.json, 3 skills, README, icon)
.claude-plugin/ marketplace.json so this repo doubles as a plugin marketplace
scripts/        configure.mjs, seed-demo.mjs, smoke-test.mjs
```

## Known limits

- **Sign-in is the workspace API key.** There are no individual user accounts, roles, or audit trail of who did what. Put your real login (SSO or accounts) behind `/authorize` before giving this to multi-user teams.
- One currency per deployment (`CURRENCY` in `wrangler.toml`); no tax handling; no credit notes (an invoice made from an order can't be voided).
- No rate limiting is built in. Add Cloudflare rate-limiting rules for `/authorize`, `/token` and `/mcp` before going public.
