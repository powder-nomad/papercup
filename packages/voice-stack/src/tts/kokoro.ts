import { StdioFramedTtsSidecar } from "./sidecar-base.js";

/**
 * Kokoro TTS via the Python sidecar at sidecar/tts_kokoro.py. ONNX-based,
 * 8-language support (en-US, en-GB, ja, zh, es, fr, hi, it, pt-BR). No
 * Korean — use {@link MeloTtsSidecar} for that.
 */
export class KokoroSidecar extends StdioFramedTtsSidecar {
  protected readonly scriptName = "tts_kokoro.py";
  protected readonly tag = "tts:kokoro";
}
