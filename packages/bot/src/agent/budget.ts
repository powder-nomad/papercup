import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_PATH = path.join(process.cwd(), "data", "budget.json");
const HISTORY_DAYS = 30;

/**
 * Per-1M-token pricing in USD ({input, output}). Hand-maintained list of
 * the common models papercup might hit. Unknown models record token counts
 * only (cost stays 0).
 *
 * Pricing snapshot: May 2026. Update when providers adjust. Keys must match
 * the `model` string actually sent to the backend.
 */
const MODEL_PRICING_PER_1M: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7":           { input: 15.0,  output: 75.0  },
  "claude-sonnet-4-6":         { input: 3.0,   output: 15.0  },
  "claude-haiku-4-5-20251001": { input: 0.8,   output: 4.0   },
  "gpt-5":                     { input: 5.0,   output: 15.0  },
  "gpt-5-mini":                { input: 0.5,   output: 2.0   },
  "gpt-4o":                    { input: 2.5,   output: 10.0  },
  "gpt-4o-mini":               { input: 0.15,  output: 0.6   },
  "o3":                        { input: 10.0,  output: 40.0  },
  "gemini-2.5-pro":            { input: 1.25,  output: 10.0  },
  "gemini-2.5-flash":          { input: 0.3,   output: 2.5   },
  "gemini-2.0-flash":          { input: 0.1,   output: 0.4   },
};

export interface DailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface BudgetFile {
  budgetUsd: number;
  usage: DailyUsage[];
}

/**
 * Per-bot budget tracker. Records token usage per day, computes USD cost
 * when the model is in the pricing table, persists to disk, exposes
 * percent-of-daily-budget for the rich-presence UI and `/budget` command.
 */
export class BudgetTracker {
  private budgetUsd = 0;
  private usage: DailyUsage[] = [];
  private file = DEFAULT_PATH;
  private writeChain: Promise<void> = Promise.resolve();

  async load(file: string = DEFAULT_PATH): Promise<void> {
    this.file = file;
    this.budgetUsd = Number(process.env.BOT_DAILY_BUDGET_USD ?? 0);
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as BudgetFile;
      if (this.budgetUsd === 0 && typeof parsed.budgetUsd === "number") {
        this.budgetUsd = parsed.budgetUsd;
      }
      if (Array.isArray(parsed.usage)) {
        this.usage = parsed.usage.filter((u) => typeof u?.date === "string");
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[budget] load failed: ${(err as Error).message}`);
      }
    }
  }

  getBudgetUsd(): number { return this.budgetUsd; }

  async setBudgetUsd(usd: number): Promise<void> {
    this.budgetUsd = Math.max(0, usd);
    await this.queueSave();
  }

  todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  getToday(): DailyUsage {
    const key = this.todayKey();
    return this.usage.find((u) => u.date === key) ?? {
      date: key, inputTokens: 0, outputTokens: 0, costUsd: 0,
    };
  }

  getRecent(days: number = 7): DailyUsage[] {
    const key = this.todayKey();
    const cutoff = new Date(`${key}T00:00:00Z`).getTime() - (days - 1) * 86_400_000;
    return this.usage.filter((u) => {
      const t = new Date(`${u.date}T00:00:00Z`).getTime();
      return t >= cutoff;
    });
  }

  getTodayPercent(): number {
    if (this.budgetUsd <= 0) return 0;
    return Math.min(100, (this.getToday().costUsd / this.budgetUsd) * 100);
  }

  isOverBudget(): boolean {
    return this.budgetUsd > 0 && this.getToday().costUsd >= this.budgetUsd;
  }

  async record(
    model: string | undefined,
    inputTokens: number,
    outputTokens: number,
  ): Promise<DailyUsage> {
    const key = this.todayKey();
    let today = this.usage.find((u) => u.date === key);
    if (!today) {
      today = { date: key, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      this.usage.push(today);
    }
    today.inputTokens += inputTokens;
    today.outputTokens += outputTokens;
    if (model && MODEL_PRICING_PER_1M[model]) {
      const p = MODEL_PRICING_PER_1M[model];
      today.costUsd +=
        (inputTokens / 1_000_000) * p.input +
        (outputTokens / 1_000_000) * p.output;
    }
    if (this.usage.length > HISTORY_DAYS) {
      this.usage = this.usage.slice(-HISTORY_DAYS);
    }
    await this.queueSave();
    return today;
  }

  private async queueSave(): Promise<void> {
    this.writeChain = this.writeChain.then(() => this.save()).catch((err) => {
      console.error(`[budget] save failed: ${(err as Error).message}`);
    });
    return this.writeChain;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const data: BudgetFile = { budgetUsd: this.budgetUsd, usage: this.usage };
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, this.file);
  }
}

export const budget = new BudgetTracker();

/**
 * Compose a short string suitable for Discord rich presence
 * (client.user.setActivity). 32-char Discord limit; we stay well under.
 */
export function richPresenceText(): string {
  const pct = budget.getTodayPercent();
  if (budget.getBudgetUsd() <= 0) {
    const t = budget.getToday();
    const totalK = Math.floor((t.inputTokens + t.outputTokens) / 1000);
    return totalK > 0 ? `${totalK}k tokens today` : "ready";
  }
  return `${pct.toFixed(0)}% of $${budget.getBudgetUsd().toFixed(0)}/day`;
}
