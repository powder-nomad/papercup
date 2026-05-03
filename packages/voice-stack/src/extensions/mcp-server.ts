import express from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ExtensionManager } from "./manager.js";

/**
 * Embedded MCP server that exposes the ExtensionManager as Claude Code tools.
 * Listens on a localhost port; each `claude -p` subprocess connects via the
 * URL passed in --mcp-config.
 */
export class ExtensionMcpServer {
  private app = express();
  private httpServer?: ReturnType<express.Express["listen"]>;
  private transports = new Map<string, StreamableHTTPServerTransport>();
  private port: number = 0;
  private url: string = "";

  constructor(private readonly manager: ExtensionManager) {
    this.app.use(express.json({ limit: "4mb" }));
    this.app.post("/mcp", (req, res) => this.handleMcpPost(req, res));
    this.app.get("/mcp", (req, res) => this.handleMcpGetDelete(req, res));
    this.app.delete("/mcp", (req, res) => this.handleMcpGetDelete(req, res));
  }

  async start(): Promise<{ url: string }> {
    return new Promise((resolve, reject) => {
      // Bind to 127.0.0.1 only — never expose to network.
      this.httpServer = this.app.listen(0, "127.0.0.1", () => {
        const addr = this.httpServer?.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("failed to bind MCP server"));
          return;
        }
        this.port = addr.port;
        this.url = `http://127.0.0.1:${this.port}/mcp`;
        console.log(`[mcp] listening on ${this.url}`);
        resolve({ url: this.url });
      });
    });
  }

  stop(): void {
    for (const t of this.transports.values()) t.close().catch(() => { /* ignore */ });
    this.httpServer?.close();
  }

  getUrl(): string {
    return this.url;
  }

  private buildMcpServer(): McpServer {
    const server = new McpServer({ name: "papercup-extensions", version: "0.1.0" });

    server.registerTool(
      "spawn_extension",
      {
        description:
          "Kick off a long-running background coding task. Returns immediately with an extension id. " +
          "Use for anything that involves writing files, running commands, or multi-step work. " +
          "DO NOT use for quick file reads — use Read/Glob/Grep instead. " +
          "After spawning, narrate to the user briefly ('kicking that off, give me a sec') then offer " +
          "to check status with check_extension when they ask.",
        inputSchema: {
          task: z.string().min(1).describe("Plain-English description of what the extension should do. Be specific."),
          name: z.string().optional().describe("Optional friendly name for this extension."),
        },
      },
      async ({ task, name }) => {
        const ext = await this.manager.spawn({ task, name });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              id: ext.id,
              name: ext.name,
              status: ext.status,
              dir: ext.dir,
              startedAt: ext.startedAt,
            }),
          }],
        };
      },
    );

    server.registerTool(
      "check_extension",
      {
        description:
          "Get the current status and (if completed) result of a previously-spawned extension. " +
          "Pass either the id or the friendly name.",
        inputSchema: {
          id: z.string().describe("Extension id or name"),
        },
      },
      async ({ id }) => {
        const ext = this.manager.find(id);
        if (!ext) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `no extension named "${id}"` }) }] };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              id: ext.id,
              name: ext.name,
              status: ext.status,
              startedAt: ext.startedAt,
              finishedAt: ext.finishedAt,
              durationMs: ext.durationMs,
              summary: ext.summary,
              error: ext.error,
              costUsd: ext.costUsd,
            }),
          }],
        };
      },
    );

    server.registerTool(
      "list_extensions",
      {
        description: "List recent extensions (most recent first). Useful when the user asks 'what's running' or 'what did I kick off'.",
        inputSchema: {
          limit: z.number().int().positive().max(50).optional().describe("Max number to return (default 10)."),
        },
      },
      async ({ limit }) => {
        const arr = this.manager.list({ limit: limit ?? 10 }).map((e) => ({
          id: e.id,
          name: e.name,
          status: e.status,
          task: e.task.length > 100 ? e.task.slice(0, 100) + "…" : e.task,
          startedAt: e.startedAt,
          finishedAt: e.finishedAt,
        }));
        return { content: [{ type: "text", text: JSON.stringify(arr) }] };
      },
    );

    return server;
  }

  private async handleMcpPost(req: Request, res: Response): Promise<void> {
    const sessionId = (req.headers["mcp-session-id"] as string | undefined);
    let transport: StreamableHTTPServerTransport | undefined;

    if (sessionId && this.transports.has(sessionId)) {
      transport = this.transports.get(sessionId);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          this.transports.set(id, transport!);
        },
      });
      transport.onclose = () => {
        const sid = transport?.sessionId;
        if (sid) this.transports.delete(sid);
      };
      const server = this.buildMcpServer();
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad request: invalid or missing session id" },
        id: null,
      });
      return;
    }

    await transport!.handleRequest(req, res, req.body);
  }

  private async handleMcpGetDelete(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !this.transports.has(sessionId)) {
      res.status(400).send("Invalid or missing session id");
      return;
    }
    await this.transports.get(sessionId)!.handleRequest(req, res);
  }
}
