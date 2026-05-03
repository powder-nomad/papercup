<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";

const props = defineProps<{ ko?: boolean }>();

type Stage = "idle" | "listening" | "transcribed" | "thinking" | "replying" | "spoken";

const stage = ref<Stage>("idle");
const userBars = ref<number[]>(Array(28).fill(0.15));
const botBars = ref<number[]>(Array(28).fill(0.15));

const t = computed(() => props.ko
  ? {
      channel: "# papercup-음성",
      connected: "음성 연결됨",
      userName: "당신",
      botName: "Papercup",
      sttTag: "stt",
      ttsTag: "tts",
      speakingBadge: "말하는 중",
      thinkingBadge: "생각 중…",
      userTranscript: "\"인증 서비스 스테이징에 배포하고 CI 통과하면 알려줘\"",
      botTranscript: "\"배포 시작했습니다. CI가 완료되면 알려드릴게요 — 약 4분 정도 걸릴 거예요.\"",
      footMeta: "모두 여러분의 홈랩에서 실행",
    }
  : {
      channel: "# voice-with-papercup",
      connected: "Voice connected",
      userName: "you",
      botName: "Papercup",
      sttTag: "stt",
      ttsTag: "tts",
      speakingBadge: "speaking",
      thinkingBadge: "thinking…",
      userTranscript: "\"deploy the auth service to staging and tell me when CI's green\"",
      botTranscript: "\"Kicked off the deploy. I'll ping you when CI finishes — should be about four minutes.\"",
      footMeta: "all running on your homelab",
    });

let timer: ReturnType<typeof setTimeout> | null = null;
let raf: number | null = null;

const cycle = () => {
  // 0.0s - 1.6s: user speaking (waveform animates)
  stage.value = "listening";
  // 1.6s - 2.0s: transcript appears
  timer = setTimeout(() => {
    stage.value = "transcribed";
    timer = setTimeout(() => {
      // 2.0s - 3.2s: bot thinking
      stage.value = "thinking";
      timer = setTimeout(() => {
        // 3.2s - 4.0s: bot reply appears
        stage.value = "replying";
        timer = setTimeout(() => {
          // 4.0s - 5.6s: bot speaking back
          stage.value = "spoken";
          timer = setTimeout(() => {
            // restart
            stage.value = "idle";
            timer = setTimeout(cycle, 600);
          }, 1600);
        }, 800);
      }, 1200);
    }, 400);
  }, 1600);
};

const animateBars = () => {
  if (stage.value === "listening") {
    userBars.value = userBars.value.map(() => 0.2 + Math.random() * 0.8);
  } else {
    userBars.value = userBars.value.map((b) => Math.max(0.12, b * 0.85));
  }
  if (stage.value === "spoken") {
    botBars.value = botBars.value.map(() => 0.2 + Math.random() * 0.8);
  } else {
    botBars.value = botBars.value.map((b) => Math.max(0.12, b * 0.85));
  }
  raf = requestAnimationFrame(animateBars);
};

onMounted(() => {
  cycle();
  raf = requestAnimationFrame(animateBars);
});

onUnmounted(() => {
  if (timer) clearTimeout(timer);
  if (raf) cancelAnimationFrame(raf);
});
</script>

<template>
  <div class="callwin" role="img" aria-label="Animated demo: user speaks, Papercup transcribes, replies, and speaks back">
    <div class="callwin-chrome">
      <span class="dot dot-r" />
      <span class="dot dot-y" />
      <span class="dot dot-g" />
      <span class="title">{{ t.channel }}</span>
      <span class="status">
        <span class="status-dot" />
        {{ t.connected }}
      </span>
    </div>

    <div class="callwin-body">
      <!-- User row -->
      <div class="row" :class="{ active: stage === 'listening' }">
        <div class="avatar avatar-user">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="currentColor" d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-3.3 0-8 1.7-8 5v1h16v-1c0-3.3-4.7-5-8-5Z"/>
          </svg>
        </div>
        <div class="rowmain">
          <div class="rowhead">
            <span class="name name-user">{{ t.userName }}</span>
            <span class="badge" v-if="stage === 'listening'">{{ t.speakingBadge }}</span>
          </div>
          <div class="bubble bubble-user" v-if="stage === 'listening' || stage === 'transcribed' || stage === 'thinking' || stage === 'replying' || stage === 'spoken'">
            <div class="wave" v-if="stage === 'listening'">
              <span v-for="(h, i) in userBars" :key="i" :style="{ height: (h * 100) + '%' }" />
            </div>
            <div class="transcript" v-else>
              <span class="ts-tag">{{ t.sttTag }}</span>
              {{ t.userTranscript }}
            </div>
          </div>
        </div>
      </div>

      <!-- Bot row -->
      <div class="row" :class="{ active: stage === 'thinking' || stage === 'spoken' }">
        <div class="avatar avatar-bot">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="currentColor" d="M6 8h12v9a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V8Zm-1-3h14a1 1 0 0 1 1 1v1H4V6a1 1 0 0 1 1-1Z"/>
          </svg>
        </div>
        <div class="rowmain">
          <div class="rowhead">
            <span class="name name-bot">{{ t.botName }}</span>
            <span class="badge badge-bot" v-if="stage === 'thinking'">{{ t.thinkingBadge }}</span>
            <span class="badge badge-bot" v-else-if="stage === 'spoken'">{{ t.speakingBadge }}</span>
          </div>
          <div class="bubble bubble-bot bubble-thinking" v-if="stage === 'thinking'">
            <span class="dotsani"><i /><i /><i /></span>
            <span class="muted">spawn_extension(deploy-auth-staging)</span>
          </div>
          <div class="bubble bubble-bot" v-else-if="stage === 'replying' || stage === 'spoken'">
            <div class="wave wave-bot" v-if="stage === 'spoken'">
              <span v-for="(h, i) in botBars" :key="i" :style="{ height: (h * 100) + '%' }" />
            </div>
            <div class="transcript" v-else>
              <span class="ts-tag ts-tag-bot">{{ t.ttsTag }}</span>
              {{ t.botTranscript }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="callwin-foot">
      <span class="foot-pill" :class="{ on: stage === 'listening' }">
        <span class="led" /> VAD
      </span>
      <span class="foot-pill" :class="{ on: stage === 'transcribed' || stage === 'thinking' }">
        <span class="led" /> Whisper
      </span>
      <span class="foot-pill" :class="{ on: stage === 'thinking' }">
        <span class="led" /> Claude Code
      </span>
      <span class="foot-pill" :class="{ on: stage === 'replying' || stage === 'spoken' }">
        <span class="led" /> Kokoro
      </span>
      <span class="foot-meta">{{ t.footMeta }}</span>
    </div>
  </div>
</template>

<style scoped>
.callwin {
  --pc-blurple: #5865f2;
  --pc-green: #57f287;
  --pc-red: #ed4245;
  --pc-yellow: #fee75c;
  --pc-bg: #1e1f22;
  --pc-bg2: #2b2d31;
  --pc-bg3: #313338;
  --pc-line: #1e1f22;
  --pc-text: #dbdee1;
  --pc-mute: #949ba4;
  border-radius: 14px;
  background: var(--pc-bg2);
  border: 1px solid #1a1b1e;
  box-shadow:
    0 30px 60px -20px rgba(88, 101, 242, 0.25),
    0 10px 30px -10px rgba(0, 0, 0, 0.6),
    inset 0 1px 0 rgba(255, 255, 255, 0.04);
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "gg sans", "Segoe UI", system-ui, sans-serif;
  color: var(--pc-text);
  width: 100%;
  max-width: 560px;
  font-size: 14px;
}

.callwin-chrome {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--pc-bg);
  border-bottom: 1px solid var(--pc-line);
}
.dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  display: inline-block;
}
.dot-r { background: var(--pc-red); }
.dot-y { background: var(--pc-yellow); }
.dot-g { background: var(--pc-green); }
.title {
  margin-left: 8px;
  color: var(--pc-mute);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.status {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--pc-mute);
  white-space: nowrap;
  flex-shrink: 0;
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--pc-green);
  box-shadow: 0 0 8px var(--pc-green);
  animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

.callwin-body {
  padding: 14px 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 220px;
}

.row {
  display: flex;
  gap: 12px;
  opacity: 0.55;
  transition: opacity 0.25s ease;
}
.row.active { opacity: 1; }

.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 14px;
  flex-shrink: 0;
}
.avatar-user {
  background: linear-gradient(135deg, #f47b67 0%, #f59e0b 100%);
  color: #fff;
  font-family: inherit;
}
.avatar-bot {
  background: linear-gradient(135deg, var(--pc-blurple) 0%, #4752c4 100%);
  color: #fff;
}

.rowmain { flex: 1; min-width: 0; }
.rowhead {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 13px;
  line-height: 1;
}
.name { font-weight: 600; }
.name-user { color: #f59e0b; }
.name-bot  { color: #a3acff; }

.badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
}
.badge-bot {
  background: rgba(88, 101, 242, 0.18);
  color: #a3acff;
}

.bubble {
  background: var(--pc-bg3);
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.5;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
}
.bubble-thinking {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
}

.transcript {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.ts-tag {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px;
  background: rgba(245, 158, 11, 0.18);
  color: #f59e0b;
  padding: 2px 5px;
  border-radius: 3px;
  text-transform: lowercase;
  letter-spacing: 0.06em;
  line-height: 1;
}
.ts-tag-bot {
  background: rgba(88, 101, 242, 0.2);
  color: #a3acff;
}

.wave {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 22px;
  width: 100%;
  max-width: 320px;
}
.wave span {
  flex: 1;
  background: #f59e0b;
  border-radius: 1.5px;
  min-height: 2px;
  transition: height 0.08s linear;
  box-shadow: 0 0 6px rgba(245, 158, 11, 0.5);
}
.wave-bot span {
  background: var(--pc-blurple);
  box-shadow: 0 0 6px rgba(88, 101, 242, 0.5);
}

.muted { color: var(--pc-mute); }

.dotsani {
  display: inline-flex;
  gap: 3px;
}
.dotsani i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--pc-blurple);
  opacity: 0.4;
  animation: dotpulse 1.2s ease-in-out infinite;
}
.dotsani i:nth-child(2) { animation-delay: 0.15s; }
.dotsani i:nth-child(3) { animation-delay: 0.3s; }
@keyframes dotpulse {
  0%, 100% { opacity: 0.3; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-2px); }
}

.callwin-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  background: var(--pc-bg);
  border-top: 1px solid var(--pc-line);
  font-size: 11px;
  color: var(--pc-mute);
  flex-wrap: wrap;
}
.foot-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 7px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.foot-pill .led {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--pc-mute);
  opacity: 0.4;
  transition: all 0.2s ease;
}
.foot-pill.on {
  color: var(--pc-text);
  background: rgba(87, 242, 135, 0.08);
  border-color: rgba(87, 242, 135, 0.25);
}
.foot-pill.on .led {
  background: var(--pc-green);
  opacity: 1;
  box-shadow: 0 0 8px var(--pc-green);
}
.foot-meta {
  margin-left: auto;
  font-style: italic;
  font-size: 11px;
}

@media (max-width: 520px) {
  .foot-meta { display: none; }
  .callwin-body { min-height: 180px; }
  .bubble { font-size: 12px; }
}
</style>
