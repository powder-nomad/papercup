/**
 * OpenCode serve backend — long-lived `opencode serve` HTTP+SSE transport.
 *
 * Unlike the per-turn `opencode-cli` backend (which spawns `opencode run`
 * fresh each turn), this backend keeps ONE `opencode serve` process alive
 * for the lifetime of the dispatcher and talks to it via its HTTP API.
 *
 * Benefits over opencode-cli:
 *   - No cold start per turn (server and model stay warm)
 *   - Live streaming via SSE `message.part.updated` events (fires onEvent)
 *   - Cancel via `POST /session/{id}/abort`
 *   - Single process shared across all active sessions
 *
 * API used (v2, no /api prefix):
 *   POST /session          create session with model + per-session cwd
 *   POST /session/{id}/message  send a user message
 *   GET  /event            global SSE stream (all sessions, demuxed by sessionID)
 *   POST /session/{id}/abort   cancel an in-flight turn
 *
 * Turn completion: `session.idle` event OR `session.status {type:"idle"}`.
 * Text streaming:  `message.part.updated` where `part.type === "text"`.
 * Token tracking:  `message.part.updated` where `part.type === "step-finish"`.
 *
 * Env config:
 *   OPENCODE_BINARY        — override binary (default: ~/.opencode/bin/opencode)
 *   OPENCODE_DEFAULT_MODEL — fallback "providerID/modelID" (e.g. ollama/gemma4-e4b)
 *   OPENCODE_SERVE_PORT    — fixed port for the server (default: random)
 *   OPENCODE_WORKDIR       — per-session cwd override (else opts.cwd)
 *   OPENCODE_EXTRA_ARGS    — extra CLI flags appended to `opencode serve`
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { AgentBackend, AgentBackendOpts, AgentReply, RespondOptions } from "./registry.ts";
import { resolveOpencodeBinary } from "./opencode-cli.ts";

// ---------------------------------------------------------------------------
// Singleton server manager
// ---------------------------------------------------------------------------

type TurnAwaiter = {
  resolve: (reply: AgentReply) => void;
  reject: (err: Error) => void;
  textChunks: string[];
  inputTokens: number;
  outputTokens: number;
  startMs: number;
  onEvent?: (ev: import("./registry.ts").TurnEvent) => void;
};

class OpencodeServerManager {
  private proc?: ChildProcess;
  private baseUrl?: string;
  private eventAbort?: AbortController;
  /** sessionId → turn awaiter (only one in-flight per session at a time). */
  private readonly turnsInFlight = new Map<string, TurnAwaiter>();
  private bootPromise?: Promise<string>;
  private bootAbort?: AbortController;

  /** Ensure the server is running; return its base URL. */
  async ensureServer(binary: string, extraArgs: string[], mcpConfigPath?: string): Promise<string> {
    if (this.baseUrl && this.proc && !this.proc.killed) return this.baseUrl;
    if (this.bootPromise) return this.bootPromise;

    this.bootAbort = new AbortController();
    this.bootPromise = this.startServer(binary, extraArgs, mcpConfigPath).finally(() => {
      this.bootPromise = undefined;
      this.bootAbort = undefined;
    });
    return this.bootPromise;
  }

  private async startServer(binary: string, extraArgs: string[], mcpConfigPath?: string): Promise<string> {
    const portArg = process.env.OPENCODE_SERVE_PORT ?? "0";
    const args = ["serve", "--port", portArg, "--print-logs", "--log-level", "WARN", ...extraArgs];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(mcpConfigPath ? { OPENCODE_CONFIG: mcpConfigPath } : {}),
    };

    return new Promise<string>((resolve, reject) => {
      const proc = spawn(binary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      this.proc = proc;

      let stderr = "";
      let resolved = false;
      let port: number | undefined;

      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        // opencode prints: "opencode server listening on http://127.0.0.1:<port>"
        const m = text.match(/listening on (http:\/\/[\d.]+:\d+)/);
        if (m && !resolved) {
          port = parseInt(new URL(m[1]).port, 10);
          this.baseUrl = m[1];
          resolved = true;
          this.startEventStream(m[1]);
          resolve(m[1]);
        }
      });

      proc.on("exit", (code) => {
        const wasRunning = !!this.baseUrl;
        this.baseUrl = undefined;
        this.proc = undefined;
        this.stopEventStream();
        // Reject all in-flight turns
        for (const [, awaiter] of this.turnsInFlight) {
          awaiter.reject(new Error(`opencode serve exited with code ${code}`));
        }
        this.turnsInFlight.clear();
        if (!resolved) {
          reject(new Error(`opencode serve failed to start: ${stderr.slice(0, 300)}`));
        } else if (wasRunning) {
          console.warn(`[opencode-serve] server exited unexpectedly (code=${code})`);
        }
      });

      proc.on("error", (err) => {
        if (!resolved) reject(err);
      });

      // Timeout if server doesn't start in 30s
      setTimeout(() => {
        if (!resolved) {
          proc.kill();
          reject(new Error("opencode serve: timed out waiting for server to start"));
        }
      }, 30_000);
    });
  }

  /** Subscribe to the global SSE event stream and demux to in-flight turns. */
  private startEventStream(baseUrl: string): void {
    this.stopEventStream();
    const ac = new AbortController();
    this.eventAbort = ac;
    void this.readEventStream(baseUrl, ac.signal);
  }

  private stopEventStream(): void {
    this.eventAbort?.abort();
    this.eventAbort = undefined;
  }

  private async readEventStream(baseUrl: string, signal: AbortSignal): Promise<void> {
    try {
      const resp = await fetch(`${baseUrl}/event`, {
        headers: { Accept: "text/event-stream" },
        signal,
      });
      if (!resp.ok || !resp.body) return;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            this.dispatchEvent(line.slice(6));
          }
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      console.warn(`[opencode-serve] SSE stream error:`, err);
    }
  }

  private dispatchEvent(json: string): void {
    let ev: {
      type?: string;
      properties?: {
        sessionID?: string;
        status?: { type?: string };
        part?: { type?: string; text?: string; cost?: number; tokens?: { input?: number; output?: number } };
      };
    };
    try { ev = JSON.parse(json); } catch { return; }

    const sessionId = ev.properties?.sessionID;
    if (!sessionId) return;
    const awaiter = this.turnsInFlight.get(sessionId);
    if (!awaiter) return;

    const type = ev.type;
    const part = ev.properties?.part;

    if (type === "message.part.updated" && part) {
      if (part.type === "text" && typeof part.text === "string" && part.text) {
        awaiter.textChunks.push(part.text);
        awaiter.onEvent?.({ kind: "text", deltaChars: part.text.length });
      } else if (part.type === "step-finish" && part.tokens) {
        awaiter.inputTokens += Number(part.tokens.input ?? 0);
        awaiter.outputTokens += Number(part.tokens.output ?? 0);
      }
    } else if (type === "session.idle" || (type === "session.status" && ev.properties?.status?.type === "idle")) {
      this.turnsInFlight.delete(sessionId);
      awaiter.resolve({
        text: awaiter.textChunks.join("").trim(),
        inputTokens: awaiter.inputTokens,
        outputTokens: awaiter.outputTokens,
        elapsedMs: Date.now() - awaiter.startMs,
      });
    }
  }

  /** Create a new opencode session; returns the opencode session id. */
  async createSession(baseUrl: string, cwd: string, model: { id: string; providerID: string }): Promise<string> {
    const resp = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: { id: model.id, providerID: model.providerID },
        agent: "build",
        location: { directory: cwd },
      }),
    });
    if (!resp.ok) throw new Error(`opencode POST /session failed: ${resp.status}`);
    const data = await resp.json() as { id?: string };
    if (!data.id) throw new Error("opencode POST /session: no id in response");
    return data.id;
  }

  /** Send a message to a session and await the response via SSE. */
  async sendMessage(
    baseUrl: string,
    sessionId: string,
    text: string,
    opts: RespondOptions,
  ): Promise<AgentReply> {
    // Register awaiter BEFORE posting the message to avoid missing early events.
    const awaiterPromise = new Promise<AgentReply>((resolve, reject) => {
      this.turnsInFlight.set(sessionId, {
        resolve,
        reject,
        textChunks: [],
        inputTokens: 0,
        outputTokens: 0,
        startMs: Date.now(),
        onEvent: opts.onEvent,
      });
    });

    const resp = await fetch(`${baseUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "user",
        parts: [{ type: "text", text }],
      }),
    });
    if (!resp.ok) {
      this.turnsInFlight.delete(sessionId);
      throw new Error(`opencode POST /session/message failed: ${resp.status}`);
    }

    return awaiterPromise;
  }

  /** Abort an in-flight turn (cancel). */
  async abort(baseUrl: string, sessionId: string): Promise<void> {
    try {
      await fetch(`${baseUrl}/session/${sessionId}/abort`, { method: "POST" });
    } catch { /* best-effort */ }
    const awaiter = this.turnsInFlight.get(sessionId);
    if (awaiter) {
      this.turnsInFlight.delete(sessionId);
      awaiter.reject(new Error("cancelled"));
    }
  }

  /** Shut the server down (dispatcher exit / test cleanup). */
  shutdown(): void {
    this.stopEventStream();
    try { this.proc?.kill("SIGTERM"); } catch { /* best-effort */ }
    this.proc = undefined;
    this.baseUrl = undefined;
    for (const [, awaiter] of this.turnsInFlight) {
      awaiter.reject(new Error("cancelled"));
    }
    this.turnsInFlight.clear();
  }
}

/** Module-level singleton — one server for the whole dispatcher process. */
const serverManager = new OpencodeServerManager();

// ---------------------------------------------------------------------------
// AgentBackend implementation
// ---------------------------------------------------------------------------

export class OpencodeServeBackend implements AgentBackend {
  private opts!: AgentBackendOpts;
  private opencodeSessionId?: string;

  async start(opts: AgentBackendOpts): Promise<void> {
    this.opts = opts;
  }

  reset(): void {
    this.opencodeSessionId = undefined;
  }

  stop(): void {
    // Individual sessions persist on the shared server; they'll be GC'd by
    // opencode. We just drop our reference.
    this.opencodeSessionId = undefined;
  }

  cancel(): boolean {
    if (!this.opencodeSessionId) return false;
    const sid = this.opencodeSessionId;
    // Fire-and-forget; serverManager.abort() also rejects the pending respond().
    void serverManager.ensureServer(
      resolveOpencodeBinary(process.env.OPENCODE_BINARY),
      [],
    ).then(baseUrl => serverManager.abort(baseUrl, sid)).catch(() => {});
    return true;
  }

  getBackendId(): string | undefined {
    return this.opencodeSessionId;
  }

  async respond(userText: string, respondOpts: RespondOptions = {}): Promise<AgentReply> {
    const binary = resolveOpencodeBinary(process.env.OPENCODE_BINARY);
    const cwd = this.opts.cwd ?? process.env.OPENCODE_WORKDIR ?? process.cwd();
    const model = parseModel(this.opts.model ?? process.env.OPENCODE_DEFAULT_MODEL);

    if (!model) {
      throw new Error(
        "opencode-serve: no model configured — set OPENCODE_DEFAULT_MODEL (e.g. ollama/gemma4-e4b) " +
        "or use /model name:<provider/model>",
      );
    }

    const extra = (process.env.OPENCODE_EXTRA_ARGS ?? "").split(/\s+/).filter(Boolean);
    const baseUrl = await serverManager.ensureServer(binary, extra);

    if (!this.opencodeSessionId) {
      this.opencodeSessionId = await serverManager.createSession(baseUrl, cwd, model);
    }

    return serverManager.sendMessage(baseUrl, this.opencodeSessionId, userText, respondOpts);
  }
}

/** Parse "providerID/modelID" into the two parts opencode expects. */
export function parseModel(raw: string | undefined): { id: string; providerID: string } | undefined {
  if (!raw) return undefined;
  const slash = raw.indexOf("/");
  if (slash < 1) return undefined;
  return { providerID: raw.slice(0, slash), id: raw.slice(slash + 1) };
}

import { registerBackend } from "./registry.ts";
registerBackend("opencode-serve", () => new OpencodeServeBackend());
