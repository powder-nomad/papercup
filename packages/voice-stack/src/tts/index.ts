/**
 * Pluggable TTS engine interface.
 *
 * Engines run as long-lived Python sidecars (same stdio framing pattern as
 * the Whisper STT sidecar). They synthesize mono PCM at their native sample
 * rate; the bot upsamples to 48 kHz stereo for Discord playback.
 *
 * Add a new engine by:
 *   1. dropping a sidecar at `sidecar/tts_<name>.py`
 *   2. writing a wrapper class that extends `StdioFramedTtsSidecar`
 *   3. registering it in `createTts()` below
 *   4. setting `TTS_ENGINE=<name>` in `.env`
 */

export type SynthesisResult = {
  /** Mono signed-16-bit PCM at `sampleRate`. */
  pcm: Int16Array;
  sampleRate: number;
  durationMs: number;
};

export type SynthesizeOpts = {
  /** ISO 639-1 lowercase code (e.g. "en", "ko"). Engines may use this to
   *  pick a voice, or routers like {@link AutoTtsEngine} use it to pick
   *  which sub-engine to dispatch to. */
  lang?: string;
};

export interface TtsEngine {
  /** Boot the sidecar. Resolves once it's ready to accept requests. */
  start(): Promise<void>;
  /** Render `text` to PCM. Resolves with the audio. */
  synthesize(text: string, opts?: SynthesizeOpts): Promise<SynthesisResult>;
  /** Tear the sidecar down. */
  stop(): void;
}

import { KokoroSidecar } from "./kokoro.js";
import { MeloTtsSidecar } from "./melotts.js";
import { AutoTtsEngine } from "./auto.js";

// Re-export the concrete impls so consumers that want to bypass the factory
// (e.g., the OpenClaw plugin which hosts its own provider config) can use them
// directly.
export { KokoroSidecar, MeloTtsSidecar, AutoTtsEngine };

export function createTts(engine: string): TtsEngine {
  switch (engine) {
    case "kokoro":
      return new KokoroSidecar();
    case "melotts":
      return new MeloTtsSidecar();
    case "auto":
      return new AutoTtsEngine();
    default:
      throw new Error(`Unknown TTS engine: ${engine}. Supported: kokoro, melotts, auto`);
  }
}
