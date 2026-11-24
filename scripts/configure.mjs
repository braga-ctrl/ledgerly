// Stamp your real details into the project after you deploy.
//
//   node scripts/configure.mjs --url https://ledgerly.your-name.workers.dev \
//        --author "Your Name" --repo your-github-name/ledgerly --db-id <d1 database id> \
//        --contact you@example.com
//
// Every flag is optional and the script is safe to re-run with new values.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), all[i + 1]]);
    return acc;
  }, []),
);

const fail = (msg) => {
  console.error("Error: " + msg);
  process.exit(1);
};
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const writeJson = (p, v) => writeFileSync(join(root, p), JSON.stringify(v, null, 2) + "\n");

if (!Object.keys(args).length) fail("pass at least one of --url, --author, --repo, --db-id, --contact (see the comment at the top of this file)");
const changed = [];

if (args.url) {
  let u;
  try { u = new URL(args.url); } catch { fail(`--url is not a valid URL: ${args.url}`); }
  if (u.protocol !== "https:") fail("--url must start with https://");
  const base = u.origin;
  const mcp = readJson("plugin/.mcp.json");
  mcp.mcpServers.ledgerly.url = `${base}/mcp`;
  writeJson("plugin/.mcp.json", mcp);
  const manifest = readJson("plugin/.claude-plugin/plugin.json");
  manifest.privacyPolicyUrl = `${base}/privacy`;
  writeJson("plugin/.claude-plugin/plugin.json", manifest);
  const readmePath = join(root, "plugin/README.md");
  const readme = readFileSync(readmePath, "utf8").replace(/<!--host-->.*?<!--\/host-->/s, `<!--host-->${u.host}<!--/host-->`);
  writeFileSync(readmePath, readme);
  changed.push(`MCP url -> ${base}/mcp`);
}

if (args.author) {
  const plugin = readJson("plugin/.claude-plugin/plugin.json");
  plugin.author = { name: args.author };
  writeJson("plugin/.claude-plugin/plugin.json", plugin);
  const mk = readJson(".claude-plugin/marketplace.json");
  mk.owner = { name: args.author };
  writeJson(".claude-plugin/marketplace.json", mk);
  changed.push(`author -> ${args.author}`);
}

if (args.repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(args.repo)) fail("--repo must look like owner/name");
  const plugin = readJson("plugin/.claude-plugin/plugin.json");
  plugin.repository = `https://github.com/${args.repo}`;
  plugin.homepage = `https://github.com/${args.repo}`;
  writeJson("plugin/.claude-plugin/plugin.json", plugin);
  const readmePath = join(root, "plugin/README.md");
  writeFileSync(readmePath, readFileSync(readmePath, "utf8").replace(/(\/plugin install ledgerly --marketplace )\S+/, `$1${args.repo}`));
  changed.push(`repository -> github.com/${args.repo}`);
}

if (args.contact) {
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(args.contact)) fail("--contact must be an email address");
  const p = join(root, "public/privacy.html");
  const html = readFileSync(p, "utf8")
    .replace(/<!--contact-->.*?<!--\/contact-->/s, `<!--contact-->${args.contact}<!--/contact-->`)
    .replace(/mailto:[^"]*"/, `mailto:${args.contact}"`);
  writeFileSync(p, html);
  changed.push(`privacy contact -> ${args.contact}`);
}

if (args["db-id"]) {
  if (!/^[0-9a-f-]{36}$/i.test(args["db-id"])) fail("--db-id should be the UUID printed by `wrangler d1 create`");
  const p = join(root, "wrangler.toml");
  const toml = readFileSync(p, "utf8");
  if (!/database_id\s*=\s*"[^"]*"/.test(toml)) fail("could not find database_id in wrangler.toml");
  writeFileSync(p, toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${args["db-id"]}"`));
  changed.push("wrangler.toml database_id set");
}

console.log("Updated:\n  - " + changed.join("\n  - "));
