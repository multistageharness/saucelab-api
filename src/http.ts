/**
 * Streamable HTTP transport (MCP spec) for clients that cannot spawn a local
 * process: the Gemini app, ChatGPT connectors, hosted agents.
 *
 *   node build/index.js --http [--port 50010] [--host 127.0.0.1]
 *
 * Security knobs (env):
 *   MURAL_HTTP_HOST    bind address, default 127.0.0.1 (loopback only; put a tunnel/proxy in front)
 *   MURAL_HTTP_PORT    default 50010
 *   MURAL_HTTP_SECRET  if set, the endpoint moves from /mcp to /<secret>/mcp (capability URL for
 *                      clients that cannot send headers, e.g. the Gemini app)
 *   MURAL_HTTP_BEARER  if set, every request must carry `Authorization: Bearer <value>`
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface HttpOptions {
  host: string;
  port: number;
  secret?: string;
  bearer?: string;
  /** Builds a fresh McpServer for each MCP session. */
  makeServer: () => McpServer;
  log: (...args: unknown[]) => void;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

export function startHttp(opts: HttpOptions): Promise<{ url: string; close: () => void }> {
  const mcpPath = opts.secret ? `/${opts.secret}/mcp` : "/mcp";
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  const deny = (res: ServerResponse, status: number, msg: string) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: msg }, id: null }));
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ok");
    }
    if (url.pathname !== mcpPath) return deny(res, 404, "not found");
    if (opts.bearer) {
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), opts.bearer)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        return deny(res, 401, "unauthorized");
      }
    }
    try {
      const sid = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sid) ? sid[0] : sid;
      if (sessionId && sessions.has(sessionId)) {
        const body = req.method === "POST" ? await readJson(req) : undefined;
        return await sessions.get(sessionId)!.transport.handleRequest(req, res, body);
      }
      if (req.method !== "POST") return deny(res, 400, "no valid session; send an initialize request first");
      const body = await readJson(req);
      if (!isInitializeRequest(body)) return deny(res, 400, "no valid session; send an initialize request first");

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server });
          opts.log(`http session opened ${id} from ${req.socket.remoteAddress}`);
        },
      });
      const server = opts.makeServer();
      transport.onclose = () => {
        if (transport.sessionId && sessions.delete(transport.sessionId)) opts.log(`http session closed ${transport.sessionId}`);
        void server.close().catch(() => undefined);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      opts.log("http error:", err instanceof Error ? err.message : err);
      if (!res.headersSent) deny(res, 500, "internal error");
    }
  };

  const httpServer = createServer((req, res) => void handler(req, res));
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, () => {
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      const hostForUrl = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
      resolve({
        url: `http://${hostForUrl}:${port}${mcpPath}`,
        close: () => {
          for (const s of sessions.values()) void s.transport.close();
          httpServer.close();
        },
      });
    });
  });
}
