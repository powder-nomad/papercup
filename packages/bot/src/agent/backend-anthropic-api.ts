import Anthropic from "@anthropic-ai/sdk";
import type { AgentBackend, AgentBackendOpts, AgentReply } from "./backend.js";

type Turn = { role: "user" | "assistant"; content: string };

export class AnthropicApiBackend implements AgentBackend {
  private client?: Anthropic;
  private opts!: AgentBackendOpts;
  private history: Turn[] = [];

  async start(opts: AgentBackendOpts): Promise<void> {
    this.opts = opts;
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.history = [];
  }

  reset(): void {
    this.history = [];
  }

  stop(): void {
    this.history = [];
  }

  async respond(userText: string): Promise<AgentReply> {
    if (!this.client) throw new Error("AnthropicApiBackend: start() not called");
    this.history.push({ role: "user", content: userText });

    const t0 = Date.now();
    const resp = await this.client.messages.create({
      model: this.opts.model ?? "claude-haiku-4-5-20251001",
      max_tokens: this.opts.maxTokens ?? 200,
      system: this.opts.systemPrompt,
      messages: this.history.map((t) => ({ role: t.role, content: t.content })),
    });
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
