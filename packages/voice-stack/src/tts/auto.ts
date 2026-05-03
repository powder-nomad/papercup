import type { TtsEngine, SynthesisResult, SynthesizeOpts } from "./index.js";
import { KokoroSidecar } from "./kokoro.js";
import { MeloTtsSidecar } from "./melotts.js";
import { XttsSidecar } from "./xtts.js";

type KoEngine = "xtts" | "melotts";

/**
 * Routes synthesize() calls to the right underlying engine based on language.
 *
 * Today's routing:
 * - Korean (`ko`)            → XTTS-v2 (default) or MeloTTS (TTS_KO_ENGINE=melotts)
 * - everything else          → Kokoro
 *
 * Kokoro boots eagerly. The Korean engine pre-warms in the background by
 * default so the first KR call doesn't eat the load pause. Set
 * MELOTTS_PREWARM=0 / XTTS_PREWARM=0 to defer.
 */
export class AutoTtsEngine implements TtsEngine {
  private kokoro?: KokoroSidecar;
  private kokoroStart?: Promise<void>;
  private koEngineKind: KoEngine;
  private ko?: KokoroSidecar | MeloTtsSidecar | XttsSidecar;
  private koStart?: Promise<void>;

  constructor() {
    const requested = (process.env.TTS_KO_ENGINE ?? "melotts").toLowerCase();
    this.koEngineKind = requested === "xtts" ? "xtts" : "melotts";
  }

  async start(): Promise<void> {
    this.kokoro = new KokoroSidecar();
    this.kokoroStart = this.kokoro.start();

    const prewarmFlag = this.koEngineKind === "xtts" ? "XTTS_PREWARM" : "MELOTTS_PREWARM";
    const prewarm = (process.env[prewarmFlag] ?? "1") !== "0";
    if (prewarm) {
      console.log(`[tts:auto] pre-warming Korean engine (${this.koEngineKind}) in background`);
      this.spawnKoEngine();
      this.koStart = this.ko!.start().catch((err) => {
        console.error(
          `[tts:auto] ${this.koEngineKind} pre-warm failed; first KR call will retry:`,
          err,
        );
        this.ko = undefined;
        this.koStart = undefined;
      });
    }

    await this.kokoroStart;
  }

  async synthesize(text: string, opts: SynthesizeOpts = {}): Promise<SynthesisResult> {
    const lang = (opts.lang ?? "en").toLowerCase();
    if (lang.startsWith("ko")) {
      return this.viaKoEngine(text);
    }
    return this.viaKokoro(text);
  }

  private spawnKoEngine(): void {
    if (this.koEngineKind === "xtts") {
      this.ko = new XttsSidecar({ lang: "ko" });
    } else {
      this.ko = new MeloTtsSidecar({ lang: "KR" });
    }
  }

  private async viaKokoro(text: string): Promise<SynthesisResult> {
    if (!this.kokoroStart) {
      this.kokoro = new KokoroSidecar();
      this.kokoroStart = this.kokoro.start();
    }
    await this.kokoroStart;
    return this.kokoro!.synthesize(text);
  }

  private async viaKoEngine(text: string): Promise<SynthesisResult> {
    if (!this.koStart) {
      console.log(`[tts:auto] booting Korean engine ${this.koEngineKind} (lazy first-use)`);
      this.spawnKoEngine();
      this.koStart = this.ko!.start();
    }
    await this.koStart;
    return this.ko!.synthesize(text);
  }

  stop(): void {
    this.kokoro?.stop();
    this.ko?.stop();
  }
}
