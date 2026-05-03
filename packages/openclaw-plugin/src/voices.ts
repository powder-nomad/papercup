/**
 * Curated list of Kokoro v1.0 voice ids exposed via OpenClaw's
 * SpeechProviderPlugin.listVoices().
 *
 * Kokoro v1.0 ships ~54 voices — this is a curated subset spanning the
 * supported languages. Full list at https://github.com/hexgrad/kokoro.
 */

export type KokoroVoice = {
  id: string;
  name: string;
  locale: string;
  gender: "female" | "male";
  category: string;
  description?: string;
};

export const KOKORO_VOICE_CATALOG: KokoroVoice[] = [
  // American English
  { id: "af_heart",   name: "Heart",   locale: "en-US", gender: "female", category: "American English", description: "Default. Warm, conversational." },
  { id: "af_bella",   name: "Bella",   locale: "en-US", gender: "female", category: "American English" },
  { id: "af_sarah",   name: "Sarah",   locale: "en-US", gender: "female", category: "American English", description: "Calm, neutral." },
  { id: "af_nicole",  name: "Nicole",  locale: "en-US", gender: "female", category: "American English" },
  { id: "am_adam",    name: "Adam",    locale: "en-US", gender: "male",   category: "American English" },
  { id: "am_michael", name: "Michael", locale: "en-US", gender: "male",   category: "American English", description: "Deeper register." },

  // British English
  { id: "bf_emma",   name: "Emma",   locale: "en-GB", gender: "female", category: "British English" },
  { id: "bf_isabella", name: "Isabella", locale: "en-GB", gender: "female", category: "British English" },
  { id: "bm_george", name: "George", locale: "en-GB", gender: "male",   category: "British English" },
  { id: "bm_lewis",  name: "Lewis",  locale: "en-GB", gender: "male",   category: "British English" },

  // Japanese
  { id: "jf_alpha", name: "Alpha", locale: "ja-JP", gender: "female", category: "Japanese" },
  { id: "jm_kumo",  name: "Kumo",  locale: "ja-JP", gender: "male",   category: "Japanese" },

  // Mandarin
  { id: "zf_xiaobei", name: "Xiaobei", locale: "zh-CN", gender: "female", category: "Mandarin Chinese" },
  { id: "zm_yunjian", name: "Yunjian", locale: "zh-CN", gender: "male",   category: "Mandarin Chinese" },

  // Spanish
  { id: "ef_dora",  name: "Dora",  locale: "es-ES", gender: "female", category: "Spanish" },
  { id: "em_alex",  name: "Alex",  locale: "es-ES", gender: "male",   category: "Spanish" },

  // French
  { id: "ff_siwis", name: "Siwis", locale: "fr-FR", gender: "female", category: "French" },

  // Italian
  { id: "if_sara",   name: "Sara",   locale: "it-IT", gender: "female", category: "Italian" },
  { id: "im_nicola", name: "Nicola", locale: "it-IT", gender: "male",   category: "Italian" },

  // Brazilian Portuguese
  { id: "pf_dora",  name: "Dora",  locale: "pt-BR", gender: "female", category: "Portuguese (Brazil)" },
  { id: "pm_alex",  name: "Alex",  locale: "pt-BR", gender: "male",   category: "Portuguese (Brazil)" },

  // Hindi
  { id: "hf_alpha", name: "Alpha", locale: "hi-IN", gender: "female", category: "Hindi" },
  { id: "hm_omega", name: "Omega", locale: "hi-IN", gender: "male",   category: "Hindi" },
];
