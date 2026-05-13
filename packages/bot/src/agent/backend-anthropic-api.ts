import Anthropic from "@anthropic-ai/sdk";
import type { AgentBackend, AgentBackendOpts, AgentReply, RespondOptions } from "./backend.js";

type Turn = { role: "user" | "assistant"; content: string };

export class AnthropicApiBackend implements AgentBackend {
  private client?: Anthropic;
  private opts!: AgentBackendOpts;
  private history: Turn[] = [];
  private inFlight?: AbortController;

  async start(opts: AgentBackendOpts): Promise<void> {
    this.opts = opts;
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.history = [];
  }

  reset(): void {
    this.history = [];
  }

  stop(): void {
    this.cancel();
    this.history = [];
  }

  cancel(): boolean {
    if (!this.inFlight) return false;
    this.inFlight.abort();
    return true;
  }

  async respond(userText: string, _opts?: RespondOptions): Promise<AgentReply> {
    // Streaming events are not implemented for this backend; the caller's
    // onEvent (if any) is ignored. The final AgentReply is still returned.
    if (!this.client) throw new Error("AnthropicApiBackend: start() not called");
    this.history.push({ role: "user", content: userText });

    // Effort → thinking budget. minimal = thinking off, otherwise budget tokens.
    const budgetByEffort: Record<"low" | "medium" | "high" | "xhigh" | "max", number> = {
      low: 1024,
      medium: 4096,
      high: 16384,
      xhigh: 32768,
      max: 64000,
    };
    const thinking = this.opts.effort && this.opts.effort !== "minimal"
      ? { type: "enabled" as const, budget_tokens: budgetByEffort[this.opts.effort] }
      : undefined;
    // Extended thinking needs max_tokens > budget_tokens; bump if needed.
    const maxTokens = thinking
      ? Math.max(this.opts.maxTokens ?? 200, thinking.budget_tokens + 200)
      : this.opts.maxTokens ?? 200;

    const t0 = Date.now();
    this.inFlight = new AbortController();
    let resp;
    try {
      resp = await this.client.messages.create(
        {
          model: this.opts.model ?? "claude-haiku-4-5-20251001",
          max_tokens: maxTokens,
          // Voice mode supplies a system prompt; text mode omits it so the model
          // behaves as a default Claude assistant.
          ...(this.opts.systemPrompt ? { system: this.opts.systemPrompt } : {}),
          messages: this.history.map((t) => ({ role: t.role, content: t.content })),
          ...(thinking ? { thinking } : {}),
        },
        { signal: this.inFlight.signal },
      );
    } catch (err) {
      if (this.inFlight.signal.aborted) {
        throw new Error("cancelled");
      }
      throw err;
    } finally {
      this.inFlight = undefined;
    }
    const elapsedMs = Date.now() - t0;

    const text = resp.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();
    this.history.push({ role: "assistant", content: text });

    return {
      text,
      inputTokens: resp.usage.input_tokens,
      outputTokens: resp.usage.output_tokens,
      elapsedMs,
    };
  }
}

import { registerBackend } from "./backend.js";
registerBackend("anthropic-api", () => new AnthropicApiBackend());
