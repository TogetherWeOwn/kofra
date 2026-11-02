import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ServerBindings } from "@kofra/server";
import { ORIGIN, type Instance } from "./helpers";

export interface ToolCall {
  isError: boolean;
  data: Record<string, any>;
  text: string;
  content: Array<Record<string, any>>;
}

export interface McpTestClient {
  client: { listTools(): Promise<{ tools: any[] }>; callTool(p: { name: string; arguments?: Record<string, unknown> }): Promise<any>; close(): Promise<void>; getInstructions?(): string | undefined };
  call(name: string, args?: Record<string, unknown>): Promise<ToolCall>;
  tools(): Promise<any[]>;
}

/** fetch() that sends MCP traffic into the Kofra instance in-process, with a credential. */
export function mcpFetch(dw: Instance, key: string | null, extraHeaders: Record<string, string> = {}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const headers = new Headers(req.headers);
    if (key) headers.set("Authorization", `Bearer ${key}`);
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
    const ctx = createExecutionContext();
    const res = await dw.kofra.fetch(new Request(req, { headers }), env as unknown as ServerBindings, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
}

function wrap(client: McpTestClient["client"]): McpTestClient {
  return {
    client,
    async tools() {
      return (await client.listTools()).tools;
    },
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      let data = r.structuredContent as Record<string, any> | undefined;
      if (!data && r.isError) {
        const jsonLine = text.split("\n").find((l: string) => l.startsWith("{"));
        data = jsonLine ? JSON.parse(jsonLine) : {};
      }
      return { isError: !!r.isError, data: data ?? {}, text, content: r.content ?? [] };
    },
  };
}

/** An MCP SDK v2 client. modern=true negotiates the 2026-07-28 protocol; otherwise the 2025 handshake. */
export async function connectMcp(dw: Instance, key: string | null, opts: { path?: string; modern?: boolean; headers?: Record<string, string> } = {}): Promise<McpTestClient> {
  const client = new Client({ name: "dropway-test", version: "1.0.0" }, opts.modern === false ? {} : { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}${opts.path ?? "/mcp"}`), { fetch: mcpFetch(dw, key, opts.headers) as never }));
  return wrap(client as unknown as McpTestClient["client"]);
}

/** An MCP SDK v1 client (what most 2025-era agents ship). */
export async function connectLegacyMcp(dw: Instance, key: string | null, opts: { path?: string; headers?: Record<string, string> } = {}): Promise<McpTestClient> {
  const client = new LegacyClient({ name: "legacy-agent", version: "0.9.0" });
  await client.connect(new LegacyTransport(new URL(`${ORIGIN}${opts.path ?? "/mcp"}`), { fetch: mcpFetch(dw, key, opts.headers) as never }));
  return wrap(client as unknown as McpTestClient["client"]);
}

export const b64 = (s: string | Uint8Array) => btoa(String.fromCharCode(...(typeof s === "string" ? new TextEncoder().encode(s) : s)));
