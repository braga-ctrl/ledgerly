# Deploy to Cloudflare and publish the plugin

Everything below needs your own accounts, so it is a checklist for you to run. The code, plugin and docs are finished and tested. Steps 1 to 4 deploy the app. Steps 5 to 7 publish the plugin. Step 8 is the submission to Anthropic's directory.

> **Plan requirement.** Submitting to Anthropic's directory needs a **paid Claude plan** (on Team or Enterprise, an Owner submits). Steps 1 to 7 work without it: you can host the app and share the plugin through your own GitHub marketplace on any plan.

## 1. Deploy the Worker

You need Node 20+, a free [Cloudflare account](https://dash.cloudflare.com/sign-up), and this folder.

```bash
npm install
npx wrangler login

# create the database; copy the database_id it prints
npx wrangler d1 create ledgerly-db
node scripts/configure.mjs --db-id <paste-the-database_id>

# create the tables
npx wrangler d1 migrations apply ledgerly-db --remote

# the admin token protects workspace creation. Generate one and keep it somewhere safe.
openssl rand -hex 32
npx wrangler secret put ADMIN_TOKEN        # paste it when asked

npx wrangler deploy
```

`wrangler deploy` prints your URL, something like `https://ledgerly.<your-subdomain>.workers.dev`. Call it `$URL` below. Check it:

```bash
curl $URL/health          # {"ok":true,"service":"ledgerly"}
```

To change the currency, edit `CURRENCY` in `wrangler.toml` and redeploy.

### Updating a deployment that already has data

Migrations are applied in order and only once, so an update is: back up, apply the new migration, deploy.

```bash
npx wrangler d1 export ledgerly-db --remote --output backup-before-update.sql
npx wrangler d1 migrations list ledgerly-db --remote      # shows what is pending
npx wrangler d1 migrations apply ledgerly-db --remote
npx wrangler deploy
```

Apply the migration **before** deploying: the new code reads columns and tables the migration creates.

## 2. Create a workspace for your company

```bash
curl -X POST $URL/admin/orgs \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Your Company"}'
```

The response contains `api_key` (starts with `lgk_`). **It is shown once.** Open `$URL`, paste the key, and you're in the web app.

Lost or leaked a key? `POST $URL/admin/orgs/<org_id>/rotate-keys` (same admin header) deletes every key and every connected-app sign-in for that workspace and returns one new key.

## 3. Verify the deployment (optional but recommended)

```bash
BASE_URL=$URL ADMIN_TOKEN=<your admin token> node scripts/smoke-test.mjs
```

It runs 259 checks against the live Worker. It creates four throwaway workspaces named *Northwind Trading*, *Other Co*, *Third* and *Sprint One Co*, so run it on a fresh deployment, not alongside real data.

## 4. Try it in Claude as a custom connector

Before publishing anything, confirm Claude can connect:

- **claude.ai**: Settings > Connectors > Add custom connector, URL `$URL/mcp`. Connect, paste your workspace key on the sign-in page, approve, then ask "How are we doing this month?".
- **Claude Code**: `claude mcp add --transport http ledgerly $URL/mcp`, then `/mcp` and choose Authenticate.

## 5. Put your details into the plugin

```bash
node scripts/configure.mjs \
  --url $URL \
  --author "Your Name or Company" \
  --repo your-github-name/ledgerly \
  --contact you@example.com
```

This writes your real URL into `plugin/.mcp.json`, the plugin manifest and README (including the privacy policy URL, which is served at `$URL/privacy`), and your contact into the privacy page. Redeploy afterwards so the privacy page shows your contact: `npx wrangler deploy`.

**Read `public/privacy.html` and get it reviewed.** It accurately describes what this software stores, but it is a template, not legal advice.

Then validate (needs Claude Code 2.1.281 or later):

```bash
claude plugin validate ./plugin     # expect: Validation passed, no findings
claude plugin validate .            # validates the marketplace manifest
```

## 6. Push to a public GitHub repository

```bash
git init -b main && git add . && git commit -m "Ledgerly"
gh repo create your-github-name/ledgerly --public --source . --push
# or: git remote add origin https://github.com/your-github-name/ledgerly.git && git push -u origin main
```

`.gitignore` already excludes `.dev.vars`, `node_modules` and `.wrangler`. Never commit your admin token or a workspace key.

## 7. Share it from your own marketplace (no review, any plan)

The repo is already a plugin marketplace (`.claude-plugin/marketplace.json`).

- **Claude Code:** `/plugin install ledgerly --marketplace your-github-name/ledgerly`
- **claude.ai:** Customize > Plugins > Add > Add marketplace, paste the repository URL, then install **Ledgerly**.

After installing, open the plugin's **Connectors** tab (or `/mcp` in Claude Code) and connect Ledgerly. The sign-in page asks for the workspace key.

## 8. Submit to Anthropic's directory (paid plan)

Anthropic lists the plugin and its MCP server as two linked submissions at **https://claude.ai/directory/manage**. Submit the connector first.

### 8a. Prepare a reviewer account

Reviewers need a fully populated workspace.

```bash
curl -X POST $URL/admin/orgs -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"name":"Directory Review Demo"}'
BASE_URL=$URL API_KEY=<that workspace key> node scripts/seed-demo.mjs
```

The seeded workspace has clients in every onboarding state, products (two low on stock), paid, part-paid, overdue and current invoices, an order waiting to ship, and expenses. In the portal's **Test & launch** step, give reviewers: the connector URL, the workspace key to paste on the sign-in page, and a sentence saying so. Rotate that key after the review.

### 8b. Submit the connector (MCP connector)

Portal > Submit new > **MCP connector**.

| Step | What to enter |
| --- | --- |
| Connection | `$URL/mcp` |
| Tools | They sync automatically. All 35 tools have a `title` and `readOnlyHint`/`destructiveHint` annotations; `void_invoice`, `cancel_order`, `issue_credit_note` and `reverse_journal_entry` are marked destructive. |
| Listing | Name, one-liner, description, categories, documentation URL (the GitHub README), privacy policy URL `$URL/privacy`, support contact, icon `plugin/assets/icon.png` |
| Authentication | OAuth 2.0. The server supports dynamic client registration and PKCE (S256) and advertises its metadata at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`. Choose the option for users signing in through the server's own OAuth flow, with no client ID or secret to enter. |
| Test & launch | The reviewer account from 8a. Confirm you ran every tool (step 4 above, or MCP Inspector). |
| Compliance | Seven acknowledgements. Read each one honestly. Note the financial-transactions one: Ledgerly **records** transactions and moves no real money. |

### 8c. Submit the plugin (Plugin bundle)

Portal > Submit new > **Plugin bundle**.

- **Repository:** `your-github-name/ledgerly`
- **Plugin path:** `plugin`
- Select **Validate**, fix anything marked Blocking, answer the data-handling questions (it sends data only to your Ledgerly server; see the README's Data section), and submit.
- Connect GitHub to your Claude organization when asked. The repository must be **public** before the listing can go live.

Review is automatic plus, for some submissions, a human reviewer. Track status in the portal. If the plugin name `ledgerly` clashes with an existing listing, change `name` in `plugin/.claude-plugin/plugin.json` and the marketplace manifest **before** the first submission (the name can't change after release).

## Before real customers use it

1. **Replace the workspace-key sign-in** with your own login (accounts or SSO) in `src/oauth.ts` (`GET/POST /authorize`). Right now anyone holding the key is the whole company.
2. **Add Cloudflare rate limiting** on `/authorize`, `/token` and `/mcp`.
3. **Back up D1** (`npx wrangler d1 export ledgerly-db --remote --output backup.sql`) on a schedule. Check Cloudflare's current plan limits for Workers and D1 against your expected usage.
4. Decide your key and data retention policy and update `public/privacy.html` to match.

## AWS or Azure instead?

This build targets Cloudflare (D1 for storage, static assets for the UI). The business logic in `src/services.ts` is plain SQL over a thin `D1` interface, so porting to Lambda or Azure Functions means swapping that storage layer and the OAuth/MCP routes' runtime glue. It is not included here.
