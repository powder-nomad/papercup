import { StdioFramedTtsSidecar } from "./sidecar-base.js";

/**
 * MeloTTS via the Python sidecar at sidecar/tts_melotts.py.
 *
 * One sidecar instance is pinned to a single MeloTTS language model (KR, EN,
 * JP, ZH, ES, FR). The default is Korean since this engine exists primarily
 * to fill Kokoro's Korean gap; override via the `MELOTTS_LANG` env var.
 *
 * For multi-language at runtime, use multiple instances (one per language)
 * via {@link AutoTtsEngine}, which routes per-utterance based on the user's
 * detected language.
 */
export class MeloTtsSidecar extends StdioFramedTtsSidecar {
  protected readonly scriptName = "tts_melotts.py";
  protected readonly tag: string;
  private readonly lang: string;

  constructor(opts: { lang?: string } = {}) {
    super();
    this.lang = (opts.lang ?? process.env.MELOTTS_LANG ?? "KR").toUpperCase();
    this.tag = `tts:melotts:${this.lang.toLowerCase()}`;
  }

  protected override extraEnv(): NodeJS.ProcessEnv {
    return { MELOTTS_LANG: this.lang };
  }
}
