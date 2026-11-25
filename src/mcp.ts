import { HttpError, type Ctx } from "./util";
import { toolIndex, tools } from "./tools";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = [
  "Ledgerly is a B2B accounting workspace: client onboarding, orders and inventory, invoicing and payments, and a double-entry ledger.",
  "Start with get_dashboard for an overview. Money is in decimal units of the workspace currency.",
  "Clients must be approved (all onboarding documents approved) before orders or invoices can be created.",
  "Sales flow: add_product, receive_stock, create_client, update_client_document until approved, create_order, fulfill_order (creates the invoice), record_payment.",
  "Every money movement posts a balanced journal entry automatically; use get_trial_balance, get_profit_and_loss, get_ar_aging and get_journal to inspect the books.",
  "Posted entries are never edited: correct a fulfilled or paid invoice with issue_credit_note (say whether goods came back), and any other entry with reverse_journal_entry. Edits to products and clients are logged (get_audit_log).",
  "Cash payments follow the workspace cash policy (get_settings): they may return warnings or be refused if cash would go negative; always tell the user about warnings from get_dashboard.",
].join(" ");

type JsonRpcId = string | number | null;
interface RpcRequest { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: Record<string, unknown> }

const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });

async function handle(ctx: Ctx, req: RpcRequest): Promise<unknown | null> {
  const id = req.id ?? null;
  const isNotification = req.id === undefined;

  switch (req.method) {
    case "initialize": {
      const asked = typeof req.params?.protocolVersion === "string" ? (req.params.protocolVersion as string) : "";
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ledgerly", title: "Ledgerly", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: t.destructive === true, idempotentHint: t.readOnly, openWorldHint: false },
        })),
      });
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const tool = toolIndex.get(name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const out = await tool.run(ctx, args);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: false });
      } catch (e) {
        // Business and validation errors go back to the model as tool errors so it can correct itself.
        const message = e instanceof HttpError ? e.message : "Unexpected server error";
        if (!(e instanceof HttpError)) console.error("tool failure", name, e);
        return rpcResult(id, { content: [{ type: "text", text: message }], isError: true });
      }
    }
    default:
      if (isNotification || req.method.startsWith("notifications/")) return null;
      return rpcError(id, -32601, `Method not found: ${req.method}`);
  }
}

/** Minimal stateless MCP server over Streamable HTTP (JSON responses, no SSE). */
export async function mcpEndpoint(ctx: Ctx, request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }
  const messages = Array.isArray(body) ? body : [body];
  const replies: unknown[] = [];
  for (const m of messages) {
    if (typeof m !== "object" || m === null || (m as RpcRequest).jsonrpc !== "2.0" || typeof (m as RpcRequest).method !== "string") {
      // JSON-RPC responses or garbage from the client are ignored (we never send requests).
      if (typeof m === "object" && m !== null && "result" in m) continue;
      replies.push(rpcError(null, -32600, "Invalid Request"));
      continue;
    }
    const r = await handle(ctx, m as RpcRequest);
    if (r !== null) replies.push(r);
  }
  if (replies.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? replies : replies[0]);
}
