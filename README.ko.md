# Papercup

> English README → [README.md](./README.md)

**홈랩에서 실행되는 Claude Code로 가는 음성 회선.**

여러분의 컴퓨터에서 실행되는 Claude Code (또는 Codex / Anthropic API) 세션에 전화를 거는 Discord 음성 봇입니다. `/pickup`을 누르고, 전화 통화하듯 말하고, 음성으로 답을 받으세요. 완전 로컬 음성 스택 — Silero VAD + faster-whisper STT + Kokoro/MeloTTS/XTTS-v2 TTS — 음성은 여러분의 네트워크를 벗어나지 않습니다.

📖 전체 문서: [powder-nomad.github.io/papercup/ko/](https://powder-nomad.github.io/papercup/ko/) (GH Pages 활성화 후)

---

## 빠른 시작

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/powder-nomad/papercup/main/install.sh)
```

Windows (네이티브 PowerShell):

```powershell
iwr -useb https://raw.githubusercontent.com/powder-nomad/papercup/main/install.ps1 | iex
```

설치 스크립트는 세 가지 Discord 값 (토큰, 클라이언트 ID, 길드 ID)을 묻고 나머지는 자동으로 처리합니다. Mac/Linux/WSL2는 bash, 네이티브 Windows는 PowerShell을 사용합니다.

플래그로 사용자 정의된 명령이 필요하다면 [설치 마법사](https://powder-nomad.github.io/papercup/ko/#installer)를 사용하세요.

## 기능

- **`/pickup`** — 봇이 음성 채널에 참여하고 듣기 시작
- 말하기; ~600ms 무음 후 Whisper가 전사하고, 스피커 에이전트가 생각하고, 응답을 음성으로 답변
- **`/hangup`** — 세션 보존, 나중에 이름으로 이어가기 가능 (`/resume name:foo`)
- **다국어 자동 라우팅** — 한국어 → MeloTTS 또는 XTTS-v2; 그 외 → Kokoro. Whisper가 발화별 언어 자동 감지
- **서브에이전트** — 빠른 파일 읽기보다 큰 작업은 스피커가 내장 MCP 서버를 통해 샌드박스화된 백그라운드 Claude Code 인스턴스를 생성. 전화를 끊어도 계속 작동.

## 기능 매트릭스

| 구성요소 | 현재 | 비고 |
|---|---|---|
| VAD | Silero | 유일한 옵션 |
| STT | Whisper | `base`/`base.en`/`small`/`small.en`. 다국어는 `small` 기본 |
| TTS | Kokoro + MeloTTS + XTTS-v2 | ko → MeloTTS 또는 XTTS-v2 자동 라우팅 (설정 가능); en/ja/zh/es/fr/hi/it/pt → Kokoro |
| 에이전트 | **10개 백엔드** (7개 CLI + 3개 HTTP API) | claude-code · codex · aider · gemini-cli · opencode · crush · amp · anthropic-api · openai-compat · gemini-api. 런타임에서 `/backend`로 전환. |
| 실시간 진행 | sticky 메시지, 선택적 이벤트 로그 | 텍스트 모드에서 `/streaming summary\|full` |
| 예산 추적 | 일별 USD + 토큰, 하드 캡 | `BOT_DAILY_BUDGET_USD` 또는 `/budget set_usd:<n>`; 봇의 rich-presence에 현재 비율 표시 |
| 프로세스 관리 | detached spawn, 그룹 kill 취소, 부팅 리퍼 | 각 에이전트 턴은 `data/process-registry.json`에서 추적; 재시작 시 고아 프로세스 정리 |
| 멀티봇 | 루프 캡, 반응성 모드, 인-밴드 roster | 여러 papercup 봇을 한 채널에서 공동 호스팅; 캡이 봇-봇 루프 방지 |
| 전송 | Discord 음성 + 텍스트 | `/bind`로 길드별 바인딩 또는 어디서든 @멘션 |

## 세 가지 배포 형태

동일한 코어, 다른 표면 — 환경에 맞는 것을 선택:

- **독립 실행 봇** — 원라이너가 설치하는 것
- **Claude Code 플러그인** — `~/.claude/plugins`에 넣고 `/papercup:setup` 슬래시 명령으로 설정
- **OpenClaw 플러그인** — OpenClaw의 Discord 어댑터용 `SpeechProviderPlugin`

자세히: [docs/install/](docs/install/).

## 시스템 요구사항

- **OS**: Linux x86_64, macOS, 또는 Windows (전체 기능을 위해 WSL2 권장)
- **Node 20+**, **Python 3.10+**
- **디스크**: ~2 GB (Kokoro 전용)에서 ~8 GB (한국어 MeloTTS + XTTS 모델 포함)까지
- **RAM**: 최소 2 GB, 권장 4 GB
- **CPU**: 실시간 STT/TTS를 위해 4코어 이상 권장

전체 요구사항 + apt/brew 명령: [문서 인덱스 → 시스템 요구사항](https://powder-nomad.github.io/papercup/ko/#system-requirements).

## 통화 흐름

```
┌─ Discord (휴대폰 / 데스크톱) ─┐         ┌─────────── 홈랩 ────────────┐
│                              │  음성   │                              │
│  /pickup → 말하기 → /hangup  │ ──────► │  Silero VAD → Whisper STT    │
│                              │         │       ↓                      │
│  봇이 답변                    │ ◄────── │  스피커 에이전트 (Haiku)      │
│                              │ Kokoro  │       ↓                      │
└──────────────────────────────┘         │  Kokoro / MeloTTS / XTTS     │
                                         │                              │
                                         │  spawn_extension(작업) ───►  │
                                         │       Claude Code 서브에이전트│
                                         │       (샌드박스 디렉터리)     │
                                         └──────────────────────────────┘
```

## 저장소 구조

```
~/papercup/
├── install.sh / install.ps1           # 범용 플래그 기반 설치 스크립트
├── docs/                              # VitePress 사이트 → GH Pages
├── packages/
│   ├── voice-stack/   @papercup/voice-stack    # 공유 VAD/STT/TTS/audio/extensions
│   ├── bot/           @papercup/bot            # Discord 봇 + .claude-plugin/
│   └── openclaw-plugin/ @papercup/openclaw-plugin  # SpeechProviderPlugin
└── .github/workflows/docs.yml
```

## 라이선스

[MIT](./LICENSE) © Paul Kim
