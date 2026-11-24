import { Hono } from "hono";
import { createApiKey, createOrg, rotateKeys } from "./services";
import { mcpEndpoint } from "./mcp";
import { authenticateAny, mountOAuth, resourceMetadataUrl } from "./oauth";
import { toolIndex, tools } from "./tools";
import { HttpError, type Args, type Ctx, type Env } from "./util";

type Vars = { ctx: Ctx };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const bearer = (header: string | undefined) => {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return m ? m[1].trim() : null;
};

// constant-time-ish comparison for the admin token
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

app.get("/health", (c) => c.json({ ok: true, service: "ledgerly" }));

// OAuth 2.0 server for the MCP endpoint (discovery, registration, authorize, token)
mountOAuth(app);

// ---- admin: create a company workspace + first API key -----------------------
const adminOnly = async (c: any, next: () => Promise<void>) => {
  const expected = c.env.ADMIN_TOKEN;
  const given = bearer(c.req.header("Authorization"));
  if (!expected) return c.json({ error: "ADMIN_TOKEN is not configured on this deployment" }, 503);
  if (!given || !safeEqual(given, expected)) return c.json({ error: "Unauthorized" }, 401);
  await next();
};

app.post("/admin/orgs", adminOnly, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Args;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new HttpError(400, `"name" is required`);
  return c.json(await createOrg(c.env.DB, name), 201);
});

app.post("/admin/orgs/:orgId/keys", adminOnly, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Args;
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : "extra key";
  return c.json(await createApiKey(c.env.DB, c.req.param("orgId"), label), 201);
});

// Revoke everything for a workspace (leaked key, offboarding) and issue one new key
app.post("/admin/orgs/:orgId/rotate-keys", adminOnly, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Args;
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : "rotated key";
  return c.json(await rotateKeys(c.env.DB, c.req.param("orgId"), label));
});

// ---- tenant auth for /api and /mcp --------------------------------------------
// Accepts a workspace API key (lgk_…) or an OAuth access token (lga_…). The 401 carries the
// resource_metadata pointer that lets Claude discover the OAuth server and start sign-in.
const tenantAuth = async (c: any, next: () => Promise<void>) => {
  const orgId = await authenticateAny(c.env.DB, bearer(c.req.header("Authorization")));
  if (!orgId) {
    const origin = new URL(c.req.url).origin;
    return c.json({ error: "Missing or invalid credentials" }, 401, {
      "WWW-Authenticate": `Bearer realm="ledgerly", resource_metadata="${resourceMetadataUrl(origin)}"`,
    });
  }
  c.set("ctx", { db: c.env.DB, orgId, env: c.env } satisfies Ctx);
  await next();
};
app.use("/api/*", tenantAuth);
app.use("/mcp", tenantAuth);

// ---- REST: every MCP tool is also a plain JSON endpoint (the web UI uses these) ----
app.get("/api/tools", (c) =>
  c.json({
    currency: c.env.CURRENCY,
    tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, readOnly: t.readOnly })),
  }),
);

app.post("/api/tools/:name", async (c) => {
  const tool = toolIndex.get(c.req.param("name"));
  if (!tool) throw new HttpError(404, "Unknown tool");
  const args = ((await c.req.json().catch(() => ({}))) ?? {}) as Args;
  return c.json(await tool.run(c.get("ctx"), args));
});

// ---- MCP (Streamable HTTP, stateless) -------------------------------------------
app.post("/mcp", (c) => mcpEndpoint(c.get("ctx"), c.req.raw));
app.get("/mcp", (c) => c.json({ error: "This MCP server uses POST only (no server-initiated stream)." }, 405, { Allow: "POST" }));

export default app;
