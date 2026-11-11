// MCP の口（Streamable HTTP、状態なし）。要求ごとに McpServer と transport を作り、呼び手を閉じ込めたツールを載せる。
// ノードは何も持たない（NonDB）ので、MCP のセッション（Mcp-Session-Id）も持たない。応答は JSON 1回で返す
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Caller } from "../identity/identity";
import { MCP_SERVER_NAME, SKILL_MD_PATH } from "../names";
import { APP_VERSION } from "../config";
import { registerTools, type ToolClock } from "./tools";

// API を呼び手 caller として1回呼ぶ。peer が無いか自分なら手元、ほかは中継（/n/<peer>/api/...）。2xx でなくても投げずに状態と本文を返す
export type ApiCall = (caller: Caller, method: string, peer: string | undefined, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
export type McpOptions = Partial<ToolClock>;

const INSTRUCTIONS = `Claude Code Nodes (ccn): list, create and drive Claude Code sessions on this node and its peers. Read ${SKILL_MD_PATH} on this host for the workflow. To hand off a task without knowing the directory, create_session with no cwd and no prompt (an idle session in the node's lobby), send_message the request, and read_messages until stop=result: the lobby starts a child in the right directory and replies with a line \`子: <peer>/<sessionId>\`; then talk to that child directly. Otherwise: create_session or send_message (keep the returned cursor), then read_messages with after=cursor until stop is result, permission or exited.`;

export function mcpHandler(o: { nodeName: string } & McpOptions) {
  const clock: ToolClock = {
    now: o.now ?? Date.now,
    sleep: o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
    pollMs: o.pollMs ?? 1000,
  };
  return async (req: Request, caller: Caller, api: ApiCall): Promise<Response> => {
    // 状態なしなので、サーバーから流す GET のストリームと、MCP のセッションを消す DELETE は持たない（仕様では 405 を返してよい）
    if (req.method !== "POST") return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: { allow: "POST", "content-type": "application/json" } });
    const server = new McpServer({ name: MCP_SERVER_NAME, version: APP_VERSION }, { instructions: INSTRUCTIONS });
    registerTools(server, { nodeName: o.nodeName, caller, api, clock });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      await server.close().catch(() => {});
    }
  };
}
