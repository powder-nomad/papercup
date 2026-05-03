# 설정 레퍼런스

모든 설정은 `packages/bot/.env`에 있습니다. `.env.example`을 복사하여 편집하세요.

## Discord

| 변수 | 필수 | 설명 |
| --- | --- | --- |
| `DISCORD_TOKEN` | 예 | 봇 토큰 |
| `DISCORD_CLIENT_ID` | 예 | 애플리케이션 ID |
| `DISCORD_GUILD_ID` | 예 | 슬래시 명령이 등록될 서버 ID |
| `BOT_TEXT_CHANNEL_ID` | 아니요 | 글로벌 기본 바인딩 채널; 길드별 `/bind`가 우선 |

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

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `AGENT_BACKEND` | `claude-code` | `claude-code` / `codex` / `anthropic-api` |
| `AGENT_MODEL` | `haiku` | 백엔드의 `--model`에 전달 |
| `AGENT_MAX_TOKENS` | `200` | `anthropic-api`에서만 사용 |
| `ANTHROPIC_API_KEY` | — | `AGENT_BACKEND=anthropic-api`일 때 필요 |
| `CODEX_SANDBOX` | `read-only` | `read-only` / `workspace-write` / `danger-full-access` |
| `SPEAKER_TOOLS` | `Read Glob Grep` | 스피커가 인라인으로 사용 가능한 CC 도구 |
| `PROJECT_DIRS` | — | 스피커가 읽을 수 있는 절대 경로 (쉼표 구분) |

## 확장

(현재 환경 변수 없음. 샌드박스 디렉터리는 `data/extensions/<id>/`. MCP 서버는 임시 로컬호스트 포트 사용.)

## 진단

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `DUMP_PCM` | — | `1`로 설정하면 첫 의미 있는 발화를 `/tmp/papercup-*.f32`로 덤프 (오프라인 VAD/STT 디버깅용) |
