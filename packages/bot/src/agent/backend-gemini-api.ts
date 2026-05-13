import type {
  AgentBackend,
  AgentBackendOpts,
  AgentReply,
  RespondOptions,
} from "./backend.js";

/**
 * Google Gemini native API backend. Targets the Generative Language API
 * directly (NOT the OpenAI-compatible shim):
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *
 * Why native instead of openai-compat: gemini exposes features the OpenAI
 * shim doesn't (system_instruction with structured parts, native grounding /
 * Google Search retrieval when enabled, code-execution tool). Future
 * iterations can add those; v1 is stateless chat completion.
 *
 * Env config:
 *   GEMINI_API_KEY                — required (https://aistudio.google.com)
 *   GEMINI_API_BASE_URL           — override (default Google endpoint)
 *   GEMINI_API_DEFAULT_MODEL      — fallback model (e.g. "gemini-2.5-flash")
 *
 * Limitations (v1):
 *   - Stateless chat completion only; tool calling / grounding deferred.
 *   - TurnEvent streaming not emitted (no streaming endpoint usage yet).
 */

type Role = "user" | "model";
type Turn = { role: Role; parts: Array<{ text: string }> };

interface GenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { message?: string };
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiApiBackend implements AgentBackend {
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
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY not set. Get one from https://aistudio.google.com");
    }
    const baseUrl = process.env.GEMINI_API_BASE_URL ?? DEFAULT_BASE_URL;
    const model =
      this.opts.model ??
      process.env.GEMINI_API_DEFAULT_MODEL ??
      "gemini-2.5-flash";

    this.history.push({ role: "user", parts: [{ text: userText }] });

    const body: Record<string, unknown> = { contents: this.history };
    if (this.opts.systemPrompt) {
      body.system_instruction = { parts: [{ text: this.opts.systemPrompt }] };
    }
    if (this.opts.maxTokens) {
      body.generationConfig = { maxOutputTokens: this.opts.maxTokens };
    }

    const url = `${baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const t0 = Date.now();
    this.inFlight = new AbortController();
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      throw new Error(`gemini-api ${resp.status}: ${errBody.slice(0, 500)}`);
    }

    const json = (await resp.json()) as GenerateContentResponse;
    if (json.error?.message) {
      this.history.pop();
      throw new Error(`gemini-api: ${json.error.message}`);
    }

    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    const inputTokens = Number(json.usageMetadata?.promptTokenCount ?? 0);
    const outputTokens = Number(json.usageMetadata?.candidatesTokenCount ?? 0);
    const elapsedMs = Date.now() - t0;

    this.history.push({ role: "model", parts: [{ text }] });

    return { text, inputTokens, outputTokens, elapsedMs };
  }
}

import { registerBackend } from "./backend.js";
registerBackend("gemini-api", () => new GeminiApiBackend());
