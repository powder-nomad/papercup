# 스피커 에이전트 + 백엔드

스피커 에이전트가 통화를 담당합니다. 사용자의 오디오를 (STT로) 전사하고, 생각하고, TTS 레이어가 다시 음성으로 답할 텍스트를 생성합니다.

## 정의

`SpeakerAgent` (`packages/bot/src/agent/speaker.ts`)는 `AgentBackend` 주위의 얇은 shim입니다. shim은 시스템 프롬프트 + 설정을 소유하고, 백엔드는 대화 상태와 실제 모델 호출을 소유합니다.

## 백엔드

오늘 10개의 백엔드가 출시되었으며 모두 동일한 `AgentBackend` 인터페이스 뒤에 있습니다. 런타임에 `/backend name:<x>`로 전환 가능.

### CLI 에이전트 (7개)

| 백엔드 | `AGENT_BACKEND=` | 인증 | 비고 |
| --- | --- | --- | --- |
| Claude Code | `claude-code` | 기존 `claude` 로그인 | 구독 티어. `/streaming`용 `tool_use` / `tool_result` 스트리밍. MCP 통합 소유. |
| Codex | `codex` | 기존 `codex` 로그인 | OpenAI의 CLI 에이전트. 첫 턴에 자신의 thread UUID 할당. |
| Aider | `aider-cli` | [설정](/ko/config#cli-에이전트-백엔드) 참조 환경 변수 | `aider --message ... --no-stream --yes-always`. `.aider.chat.history.md`에 per-cwd 히스토리. |
| Gemini CLI | `gemini-cli` | Google CLI 로그인 | `gemini -p ... --output-format json`. JSON에서 토큰 사용량 추출. |
| OpenCode | `opencode-cli` | OpenCode 설정 | `opencode run --session <id> --format json`. 네이티브 세션 재개. |
| Crush | `crush-cli` | Crush 설정 | charmbracelet의 `crush run`. 선택적 `--yolo`로 권한 프롬프트 건너뛰기. |
| Amp | `amp-cli` | Sourcegraph 인증 | `amp -x` (execute). 프롬프트는 stdin으로 파이프. 선택적 in-prompt `@T-<thread>` 재개. |

### HTTP API (3개)

| 백엔드 | `AGENT_BACKEND=` | 인증 | 커버리지 |
| --- | --- | --- | --- |
| Anthropic API | `anthropic-api` | `ANTHROPIC_API_KEY` | 직접 API; 세션별 인-메모리 히스토리 |
| OpenAI 호환 | `openai-compat` | `OPENAI_COMPAT_*` | 단일 어댑터, base-URL 설정으로 ~10개 제공자: OpenAI, Groq, Together, Fireworks, DeepSeek, OpenRouter, LiteLLM, Ollama, LM Studio, vLLM |
| Gemini API (네이티브) | `gemini-api` | `GEMINI_API_KEY` | Google의 `generativelanguage.googleapis.com` — 네이티브 스키마, OpenAI shim 아님 |

10개 모두 `--model`/`model:`과 시스템 프롬프트를 받습니다. `claude-code`는 추가로 `--allowedTools`와 `--mcp-config`를 전달합니다. CLI 에이전트 백엔드들은 `BaseCliBackend` (detached spawn, 프로세스 레지스트리 추적, 그룹 kill 취소, 턴 타임아웃)을 공유; HTTP 백엔드들은 인-메모리 `history: Turn[]`을 유지.

### 플러그인 레지스트리

백엔드는 모듈 로드 시 자체 등록:

```ts
import { registerBackend } from "@papercup/bot/agent/backend";
registerBackend("my-thing", () => new MyBackend());
```

등록되면 새 백엔드가 `/backend`의 드롭다운, `listBackends()`, `AGENT_BACKEND=` 환경 변수 값에 나타납니다. 내장 백엔드는 각 `backend-*.ts` 파일 하단에서 이를 수행; 서드파티는 papercup 소스를 건드리지 않고 자신만의 백엔드 추가 가능.

### 모델 카탈로그

`agent/model-catalog.ts`는 `모델 id → 백엔드 후보` 정적 맵 (예: `claude-opus-4-7 → ["claude-code","anthropic-api"]`)을 유지하며, API 키가 설정되면 각 제공자의 `/models` 엔드포인트에서 라이브로 새로고침합니다. `/models`와 `/models action:refresh`가 이를 운영자에게 노출.

## 도구

스피커는 읽기 전용 내장 도구 + 실제 작업을 위임할 MCP 도구를 가집니다:

```
--allowedTools "Read Glob Grep mcp__papercup__spawn_extension mcp__papercup__check_extension mcp__papercup__list_extensions"
```

`mcp__papercup__*` 도구는 내장된 HTTP MCP 서버에서 옵니다 ([확장](/ko/components/extensions) 참조). Read/Glob/Grep은 `PROJECT_DIRS`로 지정된 디렉터리에 `--add-dir`로 제한됩니다.

## 시스템 프롬프트 — 모드 인식

스피커에는 두 가지 모드가 있고, 프롬프트는 세션이 어느 모드인지에 따라 결정됩니다.

### 음성 모드 (`/pickup mode:voice`, 기본)

`packages/bot/src/agent/speaker.ts` 상단의 전체 전화 통화 페르소나 프롬프트. 주요 동작:

- 전화 통화 간결성 (한두 문장)
- 마크다운 / 글머리 기호 / 코드 포맷팅 없음 (TTS용 일반 산문)
- URL이나 긴 ID 읽지 않기
- 사용자가 말한 언어와 같은 언어로 응답
- 한국어의 경우: 짧은 한 문장 (~15음절), TTS가 느림, 길게 할 때는 먼저 묻기
- 빠른 파일 조회는 Read/Glob/Grep을 인라인으로 사용
- 멀티 스텝 작업에는 `spawn_extension` 사용
- 도구 호출 전에 내레이션하여 사용자가 침묵 속에 있지 않게 함

### 텍스트 모드 (`/pickup mode:text`)

**시스템 프롬프트 없음.** 백엔드가 일반 Claude Code (또는 Codex / Anthropic) 세션처럼 동작 — 마크다운 OK, 멀티 문단 OK, "이건 전화 통화" 프레이밍 없음. Discord 텍스트로 vibecoding하기 위해 설계됨, 통화 간결성이 제약이 아닌 경우.

도구는 여전히 동일 (Read/Glob/Grep + MCP 확장 도구), 따라서 스피커 자체가 장시간 작업을 위임하기를 원한다면 텍스트 모드에서도 `spawn_extension`이 작동합니다.

## 세션별 노브

`SpeakerAgentOpts`는 봇이 시작 시 세션별 오버라이드를 전달할 수 있게 해줍니다:

| 옵션 | 소스 | 비고 |
| --- | --- | --- |
| `model` | `Session.model` (`/model` 또는 `/pickup model:`로 설정) | `AGENT_MODEL` 환경 변수로 폴백 |
| `effort` | `Session.effort` (`/effort` 또는 `/pickup effort:`로 설정) | Claude Code CLI에서는 `--effort`; Anthropic API에서는 `thinking.budget_tokens`; codex는 무시 |
| `mode` | `Session.mode` (`/pickup mode:`로 설정) | 프롬프트 선택 결정 (voice vs text) |
| `permissionMode` | `Session.permissionMode` (`/permissions` 또는 `/pickup permission-mode:`로 설정) | Claude Code CLI에서는 `--permission-mode`; 기본값은 모드 인식 (text=`bypassPermissions`, voice=`default`) |

대화 중 `/model`, `/effort`, `/permissions`를 사용하면 봇은 **에이전트를 핫스왑**합니다: 현재 백엔드 인스턴스를 중지하고, 업데이트된 옵션으로 새것을 시작하고, 백엔드 재개를 사용하므로 히스토리가 이어집니다.

## 왜 음성 에이전트에 Bash를 직접 주지 않는가

음성 모드는 지연 시간이 중요한 경로입니다. 장시간 도구는 통화 UX를 심각하게 저하시킵니다 — 30초 Bash 호출은 대화를 얼립니다. 무거운 작업은 확장에 속하며, 비동기로 실행되고 완료 시 보고합니다. 텍스트 모드는 더 여유가 있습니다; 통화 중 bash 동작을 원하면 `/pickup mode:text permission-mode:bypassPermissions`가 경로입니다.

## 세션 상태

각 `/pickup`은 친숙한 이름의 `SessionStore` 레코드를 생성합니다. 각 백엔드는 자신의 네이티브 세션 id를 저장 (`backendId` 필드):

- claude-code: 미리 할당된 UUID, `--session-id` (첫 턴) / `--resume` (이후)으로 전달
- codex: 백엔드가 첫 턴에 thread UUID 할당; 봇이 `getBackendId()`로 다시 동기화
- anthropic-api: 외부 세션 없음, 히스토리는 인-메모리로 유지

`/resume name:foo`는 세션을 조회하고 올바른 `backendId`를 백엔드에 전달하고 계속합니다. [세션](/ko/components/sessions) 참조.
