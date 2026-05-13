import type { Message, TextBasedChannel } from "discord.js";
import type { TurnEvent } from "../agent/backend.js";

export type StreamingMode = "off" | "summary" | "full";

const DEFAULT_THRESHOLD_MS = 5_000;
const DEFAULT_EDIT_INTERVAL_MS = 1_500;

interface RenderState {
  events: TurnEvent[];
  toolUseCount: number;
  toolResultOk: number;
  toolResultErr: number;
  textChars: number;
  thinkingCount: number;
}

/**
 * Sticky-message progress UI for one streaming turn.
 *
 * Anti-bomb mechanisms:
 *   - One Discord message per turn, edited in place (never spam)
 *   - Editing throttled (default 1.5 s) — fast bursts of events collapse
 *   - Auto-skip threshold (default 5 s) — short turns never post anything
 *   - Mode-aware: "off" never posts; "summary" shows latest activity only
 *
 * Lifecycle:
 *   const r = new ProgressRenderer(channel, "summary")
 *   r.handle(event)   // each TurnEvent from the backend
 *   await r.finalize(ok, replyChars)   // when the turn settles
 */
export class ProgressRenderer {
  private state: RenderState = {
    events: [],
    toolUseCount: 0,
    toolResultOk: 0,
    toolResultErr: 0,
    textChars: 0,
    thinkingCount: 0,
  };
  private posted?: Message;
  private startedAt = Date.now();
  private finalized = false;
  private lastEditAt = 0;
  private pendingEditTimer?: ReturnType<typeof setTimeout>;
  private thresholdTimer?: ReturnType<typeof setTimeout>;
  private postingInFlight = false;

  constructor(
    private readonly channel: TextBasedChannel,
    private readonly mode: StreamingMode,
    private readonly thresholdMs: number = DEFAULT_THRESHOLD_MS,
    private readonly editIntervalMs: number = DEFAULT_EDIT_INTERVAL_MS,
  ) {
    if (this.mode === "off") return;
    this.thresholdTimer = setTimeout(() => {
      this.thresholdTimer = undefined;
      if (!this.finalized) void this.ensurePosted();
    }, this.thresholdMs);
  }

  handle(event: TurnEvent): void {
    if (this.mode === "off" || this.finalized) return;
    this.state.events.push(event);
    switch (event.kind) {
      case "tool_use": this.state.toolUseCount++; break;
      case "tool_result": event.ok ? this.state.toolResultOk++ : this.state.toolResultErr++; break;
      case "text": this.state.textChars += event.deltaChars; break;
      case "thinking": this.state.thinkingCount++; break;
      case "error": break;
    }
    if (this.posted) this.scheduleEdit();
  }

  async finalize(ok: boolean, replyChars: number): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (this.thresholdTimer) {
      clearTimeout(this.thresholdTimer);
      this.thresholdTimer = undefined;
    }
    if (this.pendingEditTimer) {
      clearTimeout(this.pendingEditTimer);
      this.pendingEditTimer = undefined;
    }
    if (!this.posted) return; // Quick turn — never posted; leave Discord clean.
    const body = this.renderFinal(ok, replyChars);
    try {
      await this.posted.edit(body);
    } catch (err) {
      console.warn(`[progress] final edit failed: ${(err as Error).message}`);
    }
  }

  private async ensurePosted(): Promise<void> {
    if (this.posted || this.postingInFlight || this.finalized) return;
    if (!("send" in this.channel)) return;
    this.postingInFlight = true;
    try {
      const sent = await (this.channel as { send: (s: string) => Promise<Message> }).send(
        this.renderActive(),
      );
      this.posted = sent;
      this.lastEditAt = Date.now();
    } catch (err) {
      console.warn(`[progress] initial post failed: ${(err as Error).message}`);
    } finally {
      this.postingInFlight = false;
    }
  }

  private scheduleEdit(): void {
    if (this.pendingEditTimer || !this.posted) return;
    const elapsedSinceEdit = Date.now() - this.lastEditAt;
    const wait = Math.max(0, this.editIntervalMs - elapsedSinceEdit);
    this.pendingEditTimer = setTimeout(() => {
      this.pendingEditTimer = undefined;
      void this.editNow();
    }, wait);
  }

  private async editNow(): Promise<void> {
    if (!this.posted || this.finalized) return;
    try {
      await this.posted.edit(this.renderActive());
      this.lastEditAt = Date.now();
    } catch (err) {
      console.warn(`[progress] edit failed: ${(err as Error).message}`);
    }
  }

  private renderActive(): string {
    const elapsed = humanElapsed(Date.now() - this.startedAt);
    const summary = this.summary();
    if (this.mode === "full") {
      const log = this.renderEventLog();
      return `🤔 _${summary} · ${elapsed} elapsed_\n${log}`;
    }
    const lastLabel = this.lastLabel();
    return `🤔 ${lastLabel} · _${summary} · ${elapsed} elapsed_`;
  }

  private renderFinal(ok: boolean, replyChars: number): string {
    const elapsed = humanElapsed(Date.now() - this.startedAt);
    const summary = this.summary();
    const icon = ok ? "✅" : "🚫";
    const label = ok ? "Done" : "Cancelled";
    const reply = replyChars > 0 ? ` · reply ${formatChars(replyChars)} chars` : "";
    if (this.mode === "full") {
      const log = this.renderEventLog();
      return `${icon} ${label} · _${summary} · ${elapsed}${reply}_\n${log}`;
    }
    return `${icon} ${label} · _${summary} · ${elapsed}${reply}_`;
  }

  private lastLabel(): string {
    for (let i = this.state.events.length - 1; i >= 0; i--) {
      const ev = this.state.events[i]!;
      if (ev.kind === "tool_use") {
        return ev.preview ? `${ev.name}: ${ev.preview}` : ev.name;
      }
      if (ev.kind === "thinking") return "thinking…";
    }
    return "working…";
  }

  /**
   * Render the last ~8 tool_use / thinking events with adjacent identical
   * calls collapsed into `Read ×5`. Stays well under Discord's 2000-char limit.
   */
  private renderEventLog(): string {
    const interesting = this.state.events.filter(
      (e) => e.kind === "tool_use" || e.kind === "thinking",
    );
    type Row = { icon: string; label: string };
    const rows: Row[] = [];
    for (const ev of interesting) {
      if (ev.kind === "thinking") {
        rows.push({ icon: "🤔", label: "thinking" });
      } else if (ev.kind === "tool_use") {
        rows.push({
          icon: "🔧",
          label: ev.preview ? `${ev.name}: ${ev.preview}` : ev.name,
        });
      }
    }
    const collapsed: { icon: string; label: string; count: number }[] = [];
    for (const r of rows) {
      const prev = collapsed[collapsed.length - 1];
      if (prev && prev.icon === r.icon && prev.label === r.label) {
        prev.count++;
      } else {
        collapsed.push({ ...r, count: 1 });
      }
    }
    const visible = collapsed.slice(-8);
    const shownEventCount = visible.reduce((a, r) => a + r.count, 0);
    const omitted = interesting.length - shownEventCount;
    const lines = visible.map((r) =>
      r.count > 1 ? `${r.icon} ${r.label} ×${r.count}` : `${r.icon} ${r.label}`,
    );
    const header = omitted > 0 ? `_…${omitted} earlier event${omitted === 1 ? "" : "s"} omitted_\n` : "";
    const full = header + lines.join("\n");
    return full.length > 1700 ? full.slice(0, 1697) + "…" : full;
  }

  private summary(): string {
    const parts: string[] = [];
    if (this.state.toolUseCount > 0) {
      parts.push(`${this.state.toolUseCount} tool${this.state.toolUseCount === 1 ? "" : "s"}`);
    }
    if (this.state.toolResultErr > 0) {
      parts.push(`${this.state.toolResultErr} err`);
    }
    if (this.state.thinkingCount > 0) {
      parts.push(`${this.state.thinkingCount} think`);
    }
    return parts.length ? parts.join(" · ") : "no tool calls";
  }
}

function humanElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m${rem.toString().padStart(2, "0")}s`;
}

function formatChars(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}
