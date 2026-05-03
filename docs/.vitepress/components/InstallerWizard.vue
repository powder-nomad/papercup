<script setup lang="ts">
import { ref, computed } from "vue";

// Form state
const agent = ref<"claude-code" | "codex" | "anthropic-api">("claude-code");
const model = ref("haiku");
const anthropicKey = ref("");

const stt = ref<"whisper-base.en" | "whisper-base" | "whisper-small.en" | "whisper-small">("whisper-small");
const tts = ref<"kokoro" | "melotts" | "auto">("auto");
const voice = ref("af_heart");

const installDir = ref("$HOME/papercup");
const advanced = ref(false);
const silenceMs = ref(600);
const vadThreshold = ref(0.4);

const copied = ref(false);

const KOKORO_VOICES = [
  // English (American) — curated subset; full list in docs
  { id: "af_heart", label: "af_heart (US female, default)" },
  { id: "af_bella", label: "af_bella (US female, warm)" },
  { id: "af_sarah", label: "af_sarah (US female, calm)" },
  { id: "am_adam", label: "am_adam (US male)" },
  { id: "am_michael", label: "am_michael (US male, deep)" },
  // English (British)
  { id: "bf_emma", label: "bf_emma (UK female)" },
  { id: "bm_george", label: "bm_george (UK male)" },
  // Other languages
  { id: "jf_alpha", label: "jf_alpha (Japanese female)" },
  { id: "zf_xiaobei", label: "zf_xiaobei (Mandarin female)" },
];

const command = computed(() => {
  const flags: string[] = [];
  if (agent.value !== "claude-code") flags.push(`--agent ${agent.value}`);
  if (model.value !== "haiku") flags.push(`--model ${model.value}`);
  if (agent.value === "anthropic-api" && anthropicKey.value) {
    flags.push(`--anthropic-api-key '${anthropicKey.value}'`);
  }
  if (stt.value !== "whisper-small") flags.push(`--stt ${stt.value}`);
  if (tts.value !== "auto") flags.push(`--tts ${tts.value}`);
  if (voice.value !== "af_heart") flags.push(`--voice ${voice.value}`);
  if (installDir.value !== "$HOME/papercup") flags.push(`--dir '${installDir.value}'`);
  if (advanced.value) {
    if (silenceMs.value !== 600) flags.push(`--silence-ms ${silenceMs.value}`);
    if (vadThreshold.value !== 0.4) flags.push(`--vad-threshold ${vadThreshold.value}`);
  }
  const flagStr = flags.length ? " \\\n  " + flags.join(" \\\n  ") : "";
  return `bash <(curl -fsSL https://raw.githubusercontent.com/powder-nomad/papercup/main/install.sh)${flagStr}`;
});

const copy = async () => {
  try {
    await navigator.clipboard.writeText(command.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1800);
  } catch {
    /* clipboard API blocked — user can select+copy manually */
  }
};
</script>

<template>
  <div class="wiz">
    <div class="grid">
      <fieldset>
        <legend>Agent backend</legend>
        <label><input type="radio" v-model="agent" value="claude-code" /> Claude Code CLI <span class="hint">— uses your existing Claude Code login. No API key.</span></label>
        <label><input type="radio" v-model="agent" value="codex" /> Codex CLI <span class="hint">— uses ChatGPT login. No API key.</span></label>
        <label><input type="radio" v-model="agent" value="anthropic-api" /> Anthropic API <span class="hint">— direct API. Fastest. Requires key.</span></label>

        <label class="row" v-if="agent === 'anthropic-api'">
          ANTHROPIC_API_KEY
          <input v-model="anthropicKey" type="password" placeholder="sk-ant-..." />
        </label>
        <label class="row">
          Model
          <input v-model="model" placeholder="haiku" />
        </label>
      </fieldset>

      <fieldset>
        <legend>Speech-to-text (Whisper)</legend>
        <label><input type="radio" v-model="stt" value="whisper-small" /> small <span class="hint">— multilingual (default), much better Korean/JP/ZH accuracy</span></label>
        <label><input type="radio" v-model="stt" value="whisper-small.en" /> small.en <span class="hint">— English only, more accurate than base</span></label>
        <label><input type="radio" v-model="stt" value="whisper-base" /> base <span class="hint">— multilingual, lighter (~140MB) but weaker on non-English</span></label>
        <label><input type="radio" v-model="stt" value="whisper-base.en" /> base.en <span class="hint">— English only, smallest/fastest</span></label>
      </fieldset>

      <fieldset>
        <legend>Text-to-speech</legend>
        <label><input type="radio" v-model="tts" value="auto" /> auto <span class="hint">— route by detected language: Korean → MeloTTS, others → Kokoro (recommended)</span></label>
        <label><input type="radio" v-model="tts" value="kokoro" /> kokoro <span class="hint">— en/ja/zh/es/fr/hi/it/pt only. Lighter, no PyTorch dep.</span></label>
        <label><input type="radio" v-model="tts" value="melotts" /> melotts <span class="hint">— Korean and others. Heavier (~700MB extra for PyTorch).</span></label>

        <label class="row">
          Default Kokoro voice
          <select v-model="voice">
            <option v-for="v in KOKORO_VOICES" :key="v.id" :value="v.id">{{ v.label }}</option>
          </select>
        </label>
        <p class="hint" v-if="tts === 'kokoro'">
          Kokoro v1.0: English (US/UK), Japanese, Mandarin, Spanish, French, Hindi, Italian, Brazilian Portuguese. <strong>No Korean.</strong>
        </p>
        <p class="hint" v-else-if="tts === 'melotts'">
          MeloTTS pinned to Korean by default. Override via <code>MELOTTS_LANG</code>.
        </p>
        <p class="hint" v-else>
          MeloTTS lazy-boots on first non-English/JA/ZH/etc utterance, so all-English sessions don't pay the cost.
        </p>
      </fieldset>

      <fieldset>
        <legend>Install location</legend>
        <label class="row">
          <input v-model="installDir" />
        </label>
      </fieldset>

      <fieldset>
        <legend><label><input type="checkbox" v-model="advanced" /> Advanced options</label></legend>
        <template v-if="advanced">
          <label class="row">
            End-of-utterance silence (ms)
            <input v-model.number="silenceMs" type="number" min="200" max="3000" step="50" />
          </label>
          <label class="row">
            VAD threshold (0-1)
            <input v-model.number="vadThreshold" type="number" min="0" max="1" step="0.05" />
          </label>
        </template>
      </fieldset>
    </div>

    <div class="output">
      <div class="output-header">
        <strong>Your one-liner</strong>
        <button class="copy" @click="copy">{{ copied ? "Copied ✓" : "Copy" }}</button>
      </div>
      <pre><code>{{ command }}</code></pre>
      <p class="hint">
        Paste into your homelab terminal. Discord token / client ID / guild ID will be prompted interactively.
        Re-run with different flags any time to reconfigure.
      </p>
    </div>
  </div>
</template>

<style scoped>
.wiz {
  --pc-border: var(--vp-c-divider);
  --pc-bg: var(--vp-c-bg-soft);
  font-size: 14px;
  line-height: 1.5;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}
fieldset {
  border: 1px solid var(--pc-border);
  border-radius: 8px;
  padding: 12px 14px;
  margin: 0;
  background: var(--pc-bg);
}
legend {
  font-weight: 600;
  padding: 0 6px;
  color: var(--vp-c-text-1);
}
label {
  display: block;
  margin: 6px 0;
}
label.row {
  display: grid;
  grid-template-columns: 1fr;
  gap: 4px;
  margin: 8px 0;
}
input[type="text"], input[type="password"], input[type="number"], select, label.row input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--pc-border);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font: inherit;
}
input[type="radio"], input[type="checkbox"] {
  margin-right: 6px;
}
.hint {
  font-size: 12px;
  color: var(--vp-c-text-2);
}
.output {
  margin-top: 20px;
  border: 1px solid var(--pc-border);
  border-radius: 8px;
  padding: 12px 16px;
  background: var(--vp-c-bg-alt);
}
.output-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.output pre {
  margin: 0;
  padding: 12px;
  background: var(--vp-c-bg);
  border-radius: 6px;
  border: 1px solid var(--pc-border);
  overflow-x: auto;
  font-size: 13px;
}
.copy {
  border: 1px solid var(--pc-border);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  border-radius: 6px;
  padding: 4px 12px;
  cursor: pointer;
  font: inherit;
}
.copy:hover {
  background: var(--vp-c-bg-soft);
}
</style>
