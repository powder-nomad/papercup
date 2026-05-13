import type {
  AgentBackend,
  AgentBackendOpts,
  AgentReply,
  RespondOptions,
} from "./backend.js";

/**
 * Generic OpenAI-compatible chat-completions backend.
 *
 * Talks to any provider exposing the standard `/v1/chat/completions` shape:
 *   - OpenAI proper          → https://api.openai.com/v1
 *   - Groq                   → https://api.groq.com/openai/v1
 *   - Together.ai            → https://api.together.xyz/v1
 *   - Fireworks              → https://api.fireworks.ai/inference/v1
 *   - DeepSeek               → https://api.deepseek.com/v1
 *   - OpenRouter             → https://openrouter.ai/api/v1
 *   - LiteLLM proxy          → http://localhost:4000/v1
 *   - Ollama (local)         → http://localhost:11434/v1
 *   - LM Studio              → http://localhost:1234/v1
 *   - vLLM                   → http://localhost:8000/v1
 *
 * Env config:
 *   OPENAI_COMPAT_BASE_URL         — required, the /v1 prefix
 *   OPENAI_COMPAT_API_KEY          — optional (Ollama/LM Studio don't need one)
 *   OPENAI_COMPAT_MODEL_DEFAULT    — fallback if AgentBackendOpts.model unset
 *
 * Streaming events (TurnEvent) are not implemented in this first cut; the
 * backend returns the final completion only. Tool calling is not supported —
 * use a CLI agent backend (claude-code, codex, aider-cli, …) for tool work.
 */

type Turn = { role: "user" | "assistant" | "system"; content: string };

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiCompatBackend implements AgentBackend {
  private opts!: AgentBackendOpts;
  private history: Turn[] = [];
  private inFlight?: AbortController;

  async start(opts: AgentBackendOpts): Promise<void> {
    this.opts = opts;
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

  async respond(userText: string, _respondOpts: RespondOptions = {}): Promise<AgentReply> {
    const baseUrl = process.env.OPENAI_COMPAT_BASE_URL;
    if (!baseUrl) {
      throw new Error(
        "OPENAI_COMPAT_BASE_URL not set. Example: https://api.openai.com/v1 (OpenAI), " +
        "https://api.groq.com/openai/v1 (Groq), http://localhost:11434/v1 (Ollama).",
      );
    }
    const apiKey = process.env.OPENAI_COMPAT_API_KEY;
    const model =
      this.opts.model ??
      process.env.OPENAI_COMPAT_MODEL_DEFAULT ??
      "gpt-4o-mini";

    this.history.push({ role: "user", content: userText });

    // System prompt is prepended each call but NOT stored in this.history
    // (so we don't multiply system tokens on every turn).
    const messages: Turn[] = this.opts.systemPrompt
      ? [{ role: "system", content: this.opts.systemPrompt }, ...this.history]
      : [...this.history];

    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const body: Record<string, unknown> = { model, messages };
    if (this.opts.maxTokens) body.max_tokens = this.opts.maxTokens;

    const t0 = Date.now();
    this.inFlight = new AbortController();
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: this.inFlight.signal,
      });
    } catch (err) {
      this.inFlight = undefined;
      this.history.pop();
      if ((err as Error).name === "AbortError") throw new Error("cancelled");
      throw err;
    }
    this.inFlight = undefined;

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      this.history.pop();
      throw new Error(`openai-compat ${resp.status} from ${url}: ${errBody.slice(0, 500)}`);
    }

    const json = (await resp.json()) as ChatCompletionResponse;
    const text = (json.choices?.[0]?.message?.content ?? "").trim();
    const inputTokens = Number(json.usage?.prompt_tokens ?? 0);
    const outputTokens = Number(json.usage?.completion_tokens ?? 0);
    const elapsedMs = Date.now() - t0;

    this.history.push({ role: "assistant", content: text });

    return { text, inputTokens, outputTokens, elapsedMs };
  }
}

import { registerBackend } from "./backend.js";
registerBackend("openai-compat", () => new OpenAiCompatBackend());
