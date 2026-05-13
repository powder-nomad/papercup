# 설정 레퍼런스

모든 설정은 `packages/bot/.env`에 있습니다. `.env.example`을 복사하여 편집하세요.

## Discord

| 변수 | 필수 | 설명 |
| --- | --- | --- |
| `DISCORD_TOKEN` | 예 | 봇 토큰 |
| `DISCORD_CLIENT_ID` | 예 | 애플리케이션 ID |
| `DISCORD_GUILD_ID` | 예 | 슬래시 명령이 등록될 서버 ID |
| `BOT_TEXT_CHANNEL_ID` | 아니요 | 글로벌 기본 바인딩 채널; 길드별 `/bind`가 우선 |
| `BOT_ALLOWED_USERS` | 아니요 | 쉼표 구분 Discord 사용자 ID. 설정되면 해당 사용자만 봇 조작 가능. **다른 사용자에게 봇을 노출하는 모든 배포 전에 설정.** [보안](/ko/security#required-user-allowlist) 참조 |

## 음성 파이프라인

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `SILENCE_MS` | `600` | 발화 종료 무음 (ms). 낮을수록 빠르고, 높을수록 오인식 감소 |
| `VAD_THRESHOLD` | `0.4` | 음성 확률 컷오프 |
| `VAD_MIN_SPEECH_WINDOWS` | `3` | 발화로 카운트할 최소 32ms 음성 윈도우 수 |

## Whisper STT

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `WHISPER_MODEL` | `base` | `base` (다국어), `base.en` (영어), `small.en`, `small` |
| `WHISPER_DEVICE` | `cpu` | `cpu` 또는 `cuda` |
| `WHISPER_COMPUTE` | `int8` | `int8` (CPU), `float16` / `float32` (GPU) |
| `WHISPER_BEAM` | `1` | 빔 서치 너비. 높을수록 정확하고 느림 |

## TTS (Kokoro / MeloTTS)

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `TTS_ENGINE` | `auto` | `auto` (ko→MeloTTS·기타→Kokoro), `kokoro`, `melotts` |
| `KOKORO_VOICE` | `af_heart` | 로드된 54개 보이스 중 하나 |
| `KOKORO_SPEED` | `1.0` | 0.5–2.0 범위 |
| `KOKORO_LANG` | `en-us` | en-us, en-gb, ja, zh, es, fr, hi, it, pt-br |
| `KOKORO_MODEL` | (자동 해결) | 모델 파일 경로 오버라이드 |
| `KOKORO_VOICES` | (자동 해결) | 보이스 파일 경로 오버라이드 |
| `MELOTTS_LANG` | `KR` | `melotts` 엔진일 때만 사용; KR/EN/JP/ZH/ES/FR |
| `MELOTTS_DEVICE` | `cpu` | `cpu` 또는 `cuda` |

## 스피커 에이전트

### 환경 수준 (오버라이드되지 않으면 모든 세션에 적용)

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `AGENT_BACKEND` | `claude-code` | 등록된 10개 백엔드 중 하나. CLI 에이전트: `claude-code` · `codex` · `aider-cli` · `gemini-cli` · `opencode-cli` · `crush-cli` · `amp-cli`. HTTP API: `anthropic-api` · `openai-compat` · `gemini-api`. 런타임에서 `/backend`로 전환 가능. |
| `AGENT_MODEL` | `haiku` | 기본 모델. 세션별 오버라이드는 `/model name:<id>` 또는 `/pickup model:<id>` |
| `AGENT_MAX_TOKENS` | `200` | HTTP API 백엔드용 (`anthropic-api` / `openai-compat` / `gemini-api`) |
| `ANTHROPIC_API_KEY` | — | `AGENT_BACKEND=anthropic-api`일 때 필요. 모델 카탈로그 채우는 데도 사용 |
| `CODEX_SANDBOX` | `read-only` | `read-only` / `workspace-write` / `danger-full-access` |
| `SPEAKER_TOOLS` | `Read Glob Grep` | 스피커가 인라인으로 사용 가능한 CC 도구 |
| `PROJECT_DIRS` | — | 스피커가 읽을 수 있는 절대 경로 (쉼표 구분) |
| `PAPERCUP_TURN_TIMEOUT_S` | `0` (꺼짐) | 턴별 하드 캡 (초). 타임아웃 시 생성된 CLI의 프로세스 그룹에 SIGTERM을 보내고 `turn timed out after Ns`로 거부. 긴 확장 턴이 중단되지 않도록 기본값은 비활성화. |

### `openai-compat` 백엔드

`/v1/chat/completions` 엔드포인트를 사용하는 모든 제공자에 대응하는 단일 어댑터. base-URL 설정으로 OpenAI, Groq, Together.ai, Fireworks, DeepSeek, OpenRouter, LiteLLM, Ollama (로컬), LM Studio, vLLM 사용 가능.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `OPENAI_COMPAT_BASE_URL` | — | 필수. 예: `https://api.openai.com/v1`, `https://api.groq.com/openai/v1`, `http://localhost:11434/v1` (Ollama) |
| `OPENAI_COMPAT_API_KEY` | — | 선택 (Ollama/LM Studio 같은 로컬 제공자는 불필요) |
| `OPENAI_COMPAT_MODEL_DEFAULT` | `gpt-4o-mini` | `AgentBackendOpts.model`이 없을 때 폴백 |

### `gemini-api` 백엔드 (네이티브, OpenAI 호환 아님)

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `GEMINI_API_KEY` | — | 필수. [aistudio.google.com](https://aistudio.google.com)에서 발급 |
| `GEMINI_API_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` | 프록시/리전 엔드포인트 오버라이드용 |
| `GEMINI_API_DEFAULT_MODEL` | `gemini-2.5-flash` | `AgentBackendOpts.model`이 없을 때 폴백 |

### CLI 에이전트 백엔드

모든 CLI 백엔드는 동일한 패턴: 바이너리 경로 오버라이드, 격리된 작업 디렉터리, 선택적 기본 모델, 선택적 추가 인수 슬롯.

| 백엔드 | 변수 |
| --- | --- |
| `aider-cli` | `AIDER_BINARY` · `AIDER_WORKDIR` · `AIDER_EXTRA_ARGS` |
| `gemini-cli` | `GEMINI_BINARY` · `GEMINI_WORKDIR` · `GEMINI_DEFAULT_MODEL` · `GEMINI_EXTRA_ARGS` |
| `opencode-cli` | `OPENCODE_BINARY` · `OPENCODE_WORKDIR` · `OPENCODE_DEFAULT_MODEL` · `OPENCODE_EXTRA_ARGS` |
| `crush-cli` | `CRUSH_BINARY` · `CRUSH_WORKDIR` · `CRUSH_DEFAULT_MODEL` · `CRUSH_YOLO` · `CRUSH_EXTRA_ARGS` |
| `amp-cli` | `AMP_BINARY` · `AMP_WORKDIR` · `AMP_DEFAULT_MODEL` · `AMP_THREAD` · `AMP_EXTRA_ARGS` |

각 CLI는 detached 방식으로 spawn되어 `data/process-registry.json`에서 프로세스 그룹으로 추적되며 `/cancel`로 취소 가능. [프로세스 관리](/ko/components/process-management) 참조.

### 세션별 (슬래시 명령으로 설정)

`data/sessions.json`의 세션 레코드에 저장되며 `/hangup` → `/resume` 후에도 유지됩니다.

| 필드 | 설정 방법 | 설명 |
| --- | --- | --- |
| `model` | `/pickup model:<id>` 또는 `/model name:<id>` | 세션별 모델 오버라이드 (예: `claude-opus-4-7`). 핫스왑이 히스토리 보존 |
| `effort` | `/pickup effort:<level>` 또는 `/effort level:<level>` | `minimal` / `low` / `medium` / `high` / `xhigh` (Opus 전용) / `max` (Opus 전용). CLI에서는 `--effort`; Anthropic API에서는 `thinking.budget_tokens` |
| `mode` | `/pickup mode:voice|text` | 음성 모드는 전화 통화 페르소나 프롬프트 적용; 텍스트 모드는 시스템 프롬프트 없음 (기본 Claude Code 동작) |
| `permissionMode` | `/pickup permission-mode:<mode>` 또는 `/permissions mode:<mode>` | 도구 권한 정책. 모드별 기본값: text → `bypassPermissions` (vibecoding), voice → `default`. 선택지: `default` / `acceptEdits` / `auto` / `bypassPermissions` / `plan` |
| `notify` | `/notify state:on|off` | 켜져 있을 때, 확장 정착이 활성 컨테이너에 TTS 공지(음성) 또는 Discord 메시지(텍스트)를 발생 |
| `backend` | `/backend name:<x>` | 이 세션이 사용하는 에이전트 백엔드 (예: `claude-code`, `openai-compat`). 재시작 후에도 유지 |
| `backendId` | (자동) | 재개를 위한 백엔드 네이티브 세션 ID (Claude Code UUID, Codex thread id) |
| `streaming` | `/streaming mode:off|summary|full` | 텍스트 턴의 실시간 진행 UI. `off` (기본) = 최종 응답만. `summary` = 단일 한 줄 sticky 상태. `full` = sticky 멀티라인 스크롤 로그 |
| `reactivity` | `/reactivity mode:strict|loose|chatty` | 이 봇이 채널의 다른 봇들에 어떻게 반응할지. `strict` (기본)는 @-멘션 필요. [멀티봇](/ko/components/multi-bot) 참조 |
| `channelId` | (자동) | 텍스트 세션: 이 세션이 바인딩된 Discord 채널 id. 봇 재시작 후 첫 메시지에서 동일 세션을 자동 재개하는 데 사용 |

## 확장

샌드박스 디렉터리는 `data/extensions/<id>/`. MCP 서버는 임시 로컬호스트 포트 사용. 권한 정책은 환경 변수로 제어 — 전체 강화 가이드는 [보안](/ko/security#extension-sandbox).

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `EXTENSION_PERMISSION_MODE` | `bypassPermissions` | `default` / `acceptEdits` / `auto` / `bypassPermissions` / `plan`. 공개 배포 전에 강화 |
| `EXTENSION_ALLOWED_TOOLS` | `default` | 확장이 사용 가능한 도구 화이트리스트 (예: `"Read Edit Write Bash(npm *)"`) |
| `EXTENSION_DISALLOWED_TOOLS` | — | 명시적 거부 (예: `"WebFetch Bash(rm -rf *)"`) |

## 프로세스 관리

각 CLI 에이전트 턴(`anthropic-api` / `openai-compat` / `gemini-api`를 제외한 모든 백엔드)은 detached 프로세스 그룹으로 spawn되며 `data/process-registry.json`에서 추적됩니다. 봇 재시작 시 부팅 리퍼가 `botPid`가 현재 프로세스와 다른 모든 고아 프로세스를 SIGTERM합니다. 안전 보장: 봇이 명시적으로 기록한 PID만 시그널 처리됨.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PAPERCUP_TURN_TIMEOUT_S` | `0` (꺼짐) | 위 [Speaker agent / 환경 수준](#스피커-에이전트) 참조 — 동일한 변수의 상호 참조 |

전체 라이프사이클은 [프로세스 관리](/ko/components/process-management) 참조.

## 예산 추적

`data/budget.json`에 일별 USD + 토큰 추적이 영구 저장됩니다. 가격 테이블은 Claude Opus/Sonnet/Haiku 4.x, GPT-5/4o/o3, Gemini 2.5를 커버 — 알려지지 않은 모델은 토큰만 기록.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `BOT_DAILY_BUDGET_USD` | `0` (무제한) | USD 단위 일일 하드 캡. 오늘의 비용이 캡 이상이면 papercup이 응답을 거부 — 사람에게는 "budget spent" 메시지, 봇에게는 무음 무시. 캡은 UTC 자정에 리셋. `/budget set_usd:<n>`으로 런타임 오버라이드 가능. |

봇의 Discord rich-presence가 오늘의 예산 비율을 실시간 반영 (`46% of $10/day`); 사용자는 호버로 보고 `/budget`으로 자세한 분석 확인.

## 멀티봇 오케스트레이션

여러 papercup 봇이 하나의 Discord 서버에 공존 가능하며 각자 고유한 자격 증명/모델/예산을 가집니다. 여러 가드레일이 여기서 설정됩니다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `BOT_BOT_MAX_TURNS` | `3` | 채널별 캡: 마지막 사람 메시지 이후 papercup이 연속으로 응답한 횟수. 캡에 도달하면 사람이 발언할 때까지 그 채널에서 papercup이 침묵. 봇-봇 폭주 루프 방지. |
| `BOT_ROSTER_CHANNEL_ID` | — | 지정된 `#roster` 채널 (Discord 채널 id). 부팅 시 papercup이 다른 봇들의 `papercup-roster v1` 안내를 최근 메시지에서 스크랩. `/announce`와 `/refresh-roster`가 사용. |
| `BOT_WORKDIR` | `process.cwd()` | 이 봇이 선언한 파일시스템 루트. 부팅 시 다른 봇들의 workdir과 비교 — 겹치면 로그 경고만 발생. |
| `BOT_OWNER_DISCORD_ID` | — | 운영자의 Discord user-id. `/announce`에 포함되어 다른 운영자들이 이 봇의 소유자를 알 수 있게 함. |
| `BOT_DEFAULT_REACTIVITY` | `strict` | 새로 생성된 세션의 다른 봇들에 대한 기본 반응성. `/reactivity`로 세션별 오버라이드. |

전체는 [멀티봇 오케스트레이션](/ko/components/multi-bot) 참조.

## 진단

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `DUMP_PCM` | — | `1`로 설정하면 첫 의미 있는 발화를 `/tmp/papercup-*.f32`로 덤프 (오프라인 VAD/STT 디버깅용) |
