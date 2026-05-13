---
layout: page
title: Papercup — Claude Code로 가는 음성 회선
---

<div class="pc-hero">
  <div class="pc-hero-copy">
    <div class="pc-hero-tags">
      <span class="brand">v0.2 · 한국어 지원</span>
      <span class="green">완전 로컬 음성</span>
      <span>자가 호스팅</span>
      <span>MIT</span>
    </div>
    <h1>전화를 받으세요.<br/>홈랩에 말을 거세요.</h1>
    <p class="lede">
      Papercup은 여러분의 컴퓨터에서 실행되는 <strong>Claude Code</strong> 세션에 전화를 거는 Discord 음성 봇입니다. <code>/pickup</code>을 누르고, 전화 통화하듯 말하고, 음성으로 답을 받으세요. 클라우드 STT/TTS 없음. 음성은 여러분의 네트워크를 벗어나지 않습니다.
    </p>
    <OneLiner :ko="true" />
  </div>
  <div class="pc-hero-demo">
    <HeroCall :ko="true" />
  </div>
</div>

<div class="pc-section">
  <h2>무엇이 다른가</h2>
  <p class="sub">세 가지, 모두 핵심.</p>
  <div class="pc-pillars">
    <div class="pc-pillar">
      <h3><span class="pc-icon">01</span>완전 로컬 음성 스택</h3>
      <p>Silero VAD → faster-whisper STT → Kokoro/MeloTTS TTS, 모두 여러분의 하드웨어에서 Python 사이드카로 실행됩니다. 오디오는 LAN을 벗어나지 않습니다.</p>
      <span class="pc-stat">4코어에서 ~3–8초 루프</span>
    </div>
    <div class="pc-pillar">
      <h3><span class="pc-icon">02</span>전화 통화 UX</h3>
      <p>말하고, 잠깐 멈추고, 음성으로 답을 받습니다. 끊었다가 이름으로 다시 이어갈 수 있습니다. 다국어 자동 라우팅 (영어, 한국어, 일본어, 중국어, 스페인어, 프랑스어 등).</p>
      <span class="pc-stat">9개 언어 지원</span>
    </div>
    <div class="pc-pillar">
      <h3><span class="pc-icon">03</span>서브에이전트가 실제 작업 수행</h3>
      <p>스피커는 내장 MCP 서버를 통해 샌드박스화된 백그라운드 Claude Code 인스턴스에 작업을 위임합니다. 전화를 끊어도 그들은 코딩을 계속합니다.</p>
      <span class="pc-stat">spawn → check → list</span>
    </div>
  </div>
</div>

<div class="pc-section">
  <h2>설치 방법 세 가지</h2>
  <p class="sub">동일한 코어, 다른 배포 형태. 환경에 맞는 것을 선택하세요.</p>
  <div class="pc-paths">
    <a class="pc-path" href="/ko/install/one-liner">
      <span class="pc-path-tag">권장</span>
      <h3>원라이너</h3>
      <p>붙여넣고, Discord 토큰 관련 세 가지 질문에 답하면 끝. 엔진 선택은 플래그나 아래 마법사로.</p>
      <span class="pc-path-arrow">자세히 보기 →</span>
    </a>
    <a class="pc-path" href="/ko/install/cc-plugin">
      <span class="pc-path-tag">claude code 플러그인</span>
      <h3>플러그인으로</h3>
      <p><code>~/.claude/plugins</code>에 넣으세요. <code>/papercup:setup</code> / <code>start</code> / <code>status</code> 슬래시 명령으로 설정합니다.</p>
      <span class="pc-path-arrow">자세히 보기 →</span>
    </a>
    <a class="pc-path" href="/ko/install/openclaw">
      <span class="pc-path-tag">openclaw</span>
      <h3>OpenClaw 플러그인</h3>
      <p>Papercup의 음성 스택을 OpenClaw의 Discord 채널 어댑터에 <code>SpeechProviderPlugin</code>으로 추가합니다.</p>
      <span class="pc-path-arrow">자세히 보기 →</span>
    </a>
  </div>
</div>

<div class="pc-section">

## 원라이너 설정 {#installer}

<InstallerWizard />

</div>

<div class="pc-section">

## 통화 흐름

```
┌─ Discord (휴대폰 / 데스크톱) ─┐         ┌─────────── 홈랩 ────────────┐
│                              │  음성   │                              │
│  /pickup → 말하기 → /hangup  │ ──────► │  Silero VAD → Whisper STT    │
│                              │         │       ↓                      │
│  봇이 답변                    │ ◄────── │  스피커 에이전트 (Haiku)      │
│                              │ Kokoro  │       ↓                      │
└──────────────────────────────┘         │  Kokoro / MeloTTS → 오디오    │
                                         │                              │
                                         │  spawn_extension(작업) ───►  │
                                         │       Claude Code 서브에이전트│
                                         │       (샌드박스 디렉터리)     │
                                         └──────────────────────────────┘
```

스피커는 통화를 직접 처리합니다. 빠른 파일 읽기를 넘는 작업은 백그라운드 확장 — 자체 디렉터리에서 실행되는 전체 Claude Code 인스턴스 — 을 생성하고 진행 상황을 음성으로 알려줍니다. 전화를 끊어도 됩니다. 나중에 이름으로 세션을 이어갈 수 있습니다 (`/resume name:foo`).

</div>

<div class="pc-section">

## 시스템 요구사항

4코어 Linux 홈랩에서 테스트되었습니다. macOS는 기본 경로에서 동작합니다. MeloTTS (한국어) 경로는 Linux에서만 테스트되었습니다.

| | 최소 | 권장 |
| --- | --- | --- |
| OS | Linux x86_64, macOS (Intel 또는 Apple Silicon) | Ubuntu 22.04+ |
| Python | 3.10 | 3.12 |
| Node | 20 | 20+ |
| 디스크 (영어 전용, Kokoro) | 2 GB 여유 | 4 GB 여유 |
| 디스크 (한국어 / MeloTTS 포함) | 4 GB 여유 | 8 GB 여유 |
| RAM | 2 GB 여유 | 4 GB 여유 |
| CPU | 2 코어 | 4코어 이상 (실시간 STT/TTS) |
| 네트워크 | 모델 다운로드용 HTTPS 송신 | — |

### apt (Linux)

```sh
# 기본 설치 (Kokoro TTS만)
sudo apt-get install -y espeak-ng python3-venv

# + 한국어 / MeloTTS 경로
sudo apt-get install -y libmecab-dev mecab-ipadic-utf8 libssl-dev pkg-config
```

### brew (macOS)

```sh
brew install espeak-ng node python@3.12
# 한국어 경로에는 추가로 필요:
brew install mecab mecab-ipadic openssl pkg-config
```

### 추가로 필요한 것들

- **Discord 봇** — 토큰, 클라이언트 ID, 길드 (서버) ID. [Discord 개발자 포털](https://discord.com/developers/applications) → New Application → Bot. "Privileged Gateway Intents"에서 **MESSAGE CONTENT INTENT**와 **VOICE STATE**를 활성화하세요.
- **에이전트 백엔드 하나**: 로그인된 `claude` CLI (Claude Code), `codex` CLI (ChatGPT), 또는 Anthropic API 키. 위의 마법사에서 선택할 수 있습니다.

### 첫 실행 시 다운로드되는 것

- Whisper 모델 (`base` 기준 ~140 MB)
- Kokoro 보이스 + voices.bin (~100 MB)
- Silero VAD (~1.7 MB)
- **한국어 활성화 시**: 설치 시 PyTorch CPU (~700 MB); 첫 한국어 발화 시 한국어 BERT (~440 MB) 지연 로드

</div>

<div class="pc-section">

## 기능 매트릭스

| 구성요소 | 현재 | 비고 |
| --- | --- | --- |
| VAD | Silero | 유일한 옵션 |
| STT | Whisper | `base` (다국어, 기본) — 99개 언어 자동 감지; `base.en` / `small` / `small.en` 사용 가능 |
| TTS | Kokoro + MeloTTS (`auto`) | Kokoro: en/ja/zh/es/fr/hi/it/pt. MeloTTS: ko (한국어 자동 라우팅 → MeloTTS, 그 외 → Kokoro) |
| 에이전트 | **10개 백엔드** (7개 CLI + 3개 HTTP API) | claude-code · codex · aider · gemini-cli · opencode · crush · amp · anthropic-api · openai-compat · gemini-api. 런타임에서 `/backend`로 전환. |
| 실시간 진행 | sticky 메시지, 선택적 이벤트 로그 | 텍스트 모드 + `/streaming summary\|full`. 안티-스팸: 편집 throttle, 짧은 턴 자동 건너뜀 |
| 예산 추적 | 일별 USD + 토큰, 일일 캡 | `BOT_DAILY_BUDGET_USD` 또는 `/budget set_usd:<n>`; 봇의 rich-presence에 현재 비율 실시간 |
| 프로세스 관리 | detached spawn, 그룹 kill 취소, 부팅 리퍼 | 각 에이전트 턴은 `data/process-registry.json`에서 추적; 재시작 시 고아 프로세스 정리 |
| 멀티봇 | 루프 캡, 반응성 모드, 인-밴드 roster | 여러 운영자가 한 채널에서 봇을 공동 호스팅; 캡이 봇-봇 루프 방지 |
| 전송 | Discord 음성 + 텍스트 | `/bind`로 단일 채널 바인딩 또는 어디서든 @멘션 |

자세한 내용은 **[구성요소](/ko/components/voice-pipeline)** 참조.

</div>
