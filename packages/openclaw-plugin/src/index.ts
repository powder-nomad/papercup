/**
 * Papercup voice plugin for OpenClaw.
 *
 * Registers a SpeechProviderPlugin (`papercup-kokoro`) that uses Papercup's
 * local Kokoro TTS sidecar from `@papercup/voice-stack`. No cloud calls; no
 * API key. Adds high-quality local TTS to any OpenClaw channel — most
 * notably Discord, where OpenClaw doesn't have native speech.
 *
 * Plugin entry contract (see openclaw/plugin-sdk):
 *   OpenClawPluginDefinition = { register?(api), activate?(api) }
 *
 * We register the speech provider at `register` time so it's discoverable
 * during capability scanning, and lazily boot the sidecar inside the first
 * `synthesize` call so the Python process isn't started during discovery.
 */

import type {
  OpenClawPluginDefinition,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/speech-core";
import { KokoroSidecar } from "@papercup/voice-stack/tts";
import { writeWav24kMonoToBuffer } from "./wav.js";
import { KOKORO_VOICE_CATALOG } from "./voices.js";

// Single shared sidecar instance for the lifetime of the OpenClaw runtime.
// Booted lazily on first synthesize call.
let sidecar: KokoroSidecar | undefined;
let starting: Promise<void> | undefined;

async function getSidecar(): Promise<KokoroSidecar> {
  if (sidecar) return sidecar;
  if (!starting) {
    sidecar = new KokoroSidecar();
    starting = sidecar.start();
  }
  await starting;
  return sidecar!;
}

function buildProvider(): SpeechProviderPlugin {
  return {
    id: "papercup-kokoro",
    label: "Papercup Kokoro (local)",
    aliases: ["papercup", "kokoro-local"],
    autoSelectOrder: 1500, // prefer cloud-free providers over cloud ones if user hasn't configured another
    voices: KOKORO_VOICE_CATALOG.map((v) => v.id),

    isConfigured(): boolean {
      // The sidecar discovers its model files from env vars or its own
      // package's models/ directory. If the models aren't downloaded we'll
      // discover that on first synthesis attempt — no cheap probe today.
      return true;
    },

    async synthesize(req) {
      const tts = await getSidecar();
      // Voice / speed / lang come from req.providerConfig; we currently fall
      // back to the sidecar's KOKORO_* env defaults. TODO: thread these
      // through KokoroSidecar.synthesize once the sidecar protocol grows
      // per-call params.
      const result = await tts.synthesize(req.text);
      const audioBuffer = writeWav24kMonoToBuffer(result.pcm, result.sampleRate);
      return {
        audioBuffer,
        outputFormat: "audio/wav",
        fileExtension: "wav",
        voiceCompatible: true,
      };
    },

    async listVoices(_req) {
      return KOKORO_VOICE_CATALOG.map((v) => ({
        id: v.id,
        name: v.name,
        locale: v.locale,
        gender: v.gender,
        category: v.category,
        description: v.description,
      }));
    },
  };
}

const plugin: OpenClawPluginDefinition = {
  register(api: OpenClawPluginApi): void {
    api.registerSpeechProvider(buildProvider());
  },
};

export default plugin;
