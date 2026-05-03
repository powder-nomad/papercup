import { StdioFramedTtsSidecar } from "./sidecar-base.js";

/**
 * XTTS-v2 (Coqui) TTS sidecar wrapper.
 *
 * Multilingual model with built-in voice library + voice cloning from a 6s+
 * reference WAV. Used as the Korean engine because:
 *  - MeloTTS Korean has only one speaker, sounds monotone
 *  - Style-Bert-VITS2 doesn't support Korean
 *  - XTTS lets the user pick voice via XTTS_SPEAKER (built-in name) or
 *    XTTS_REFERENCE_WAV (clone from clip)
 *
 * Trade-off: ~3 GB RAM at runtime, RTF ~2-3x on a 4-core CPU. Heavier than
 * MeloTTS but voice quality is the point.
 */
export class XttsSidecar extends StdioFramedTtsSidecar {
  protected readonly scriptName = "tts_xtts.py";
  protected readonly tag: string;
  private readonly lang: string;

  constructor(opts: { lang?: string } = {}) {
    super();
    this.lang = (opts.lang ?? process.env.XTTS_LANG ?? "ko").toLowerCase();
    this.tag = `tts:xtts:${this.lang}`;
  }

  protected override extraEnv(): NodeJS.ProcessEnv {
    return { XTTS_LANG: this.lang };
  }
}
