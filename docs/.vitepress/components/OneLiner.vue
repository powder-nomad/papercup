<script setup lang="ts">
import { ref, computed } from "vue";

const props = defineProps<{ ko?: boolean }>();

const cmd = `bash <(curl -fsSL https://raw.githubusercontent.com/powder-nomad/papercup/main/install.sh)`;
const copied = ref(false);

const t = computed(() => props.ko
  ? {
      label: "Papercup을 홈랩에 설치",
      copy: "복사",
      copied: "복사됨",
      foot: "다른 엔진 / 에이전트 백엔드가 필요한가요?",
      footLink: "마법사 사용 ↓",
      copyAria: "설치 명령 복사",
    }
  : {
      label: "install Papercup on your homelab",
      copy: "Copy",
      copied: "Copied",
      foot: "Need different engines / agent backend?",
      footLink: "Use the wizard ↓",
      copyAria: "Copy install command",
    });

const copy = async () => {
  try {
    await navigator.clipboard.writeText(cmd);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    /* selection fallback */
  }
};
</script>

<template>
  <div class="oneliner">
    <div class="oneliner-head">
      <span class="prompt">$</span>
      <span class="label">{{ t.label }}</span>
    </div>
    <div class="oneliner-body">
      <code>{{ cmd }}</code>
      <button class="copy" @click="copy" :class="{ ok: copied }" :aria-label="t.copyAria">
        <svg v-if="!copied" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8 4h11v15h-2V6H8V4Zm-3 4h11v13H5V8Zm2 2v9h7v-9H7Z"/></svg>
        <svg v-else viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z"/></svg>
        {{ copied ? t.copied : t.copy }}
      </button>
    </div>
    <div class="oneliner-foot">
      {{ t.foot }} <a href="#installer">{{ t.footLink }}</a>
    </div>
  </div>
</template>

<style scoped>
.oneliner {
  border-radius: 10px;
  background: linear-gradient(180deg, #0d1117 0%, #161b22 100%);
  border: 1px solid #30363d;
  overflow: hidden;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.4;
  width: 100%;
  box-shadow: 0 12px 28px -16px rgba(0, 0, 0, 0.7);
}
.oneliner-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: rgba(255, 255, 255, 0.02);
  border-bottom: 1px solid #21262d;
  color: #8b949e;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.prompt { color: #57f287; }
.label { font-weight: 600; }

.oneliner-body {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
}
.oneliner-body code {
  flex: 1;
  color: #c9d1d9;
  background: transparent;
  white-space: nowrap;
  overflow-x: auto;
  font-size: 12.5px;
}
.copy {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  background: #21262d;
  color: #c9d1d9;
  border: 1px solid #30363d;
  border-radius: 6px;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
}
.copy:hover { background: #30363d; }
.copy.ok { color: #57f287; border-color: rgba(87, 242, 135, 0.3); }

.oneliner-foot {
  padding: 8px 14px;
  background: rgba(255, 255, 255, 0.015);
  border-top: 1px solid #21262d;
  color: #8b949e;
  font-size: 11px;
  font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
}
.oneliner-foot a {
  color: #79c0ff;
  text-decoration: none;
}
.oneliner-foot a:hover { text-decoration: underline; }
</style>
