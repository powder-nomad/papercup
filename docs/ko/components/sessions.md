# 세션

`/hangup` 후에도 살아남는 명명된 대화. `/resume name:<name>`으로 나중에 이어가기.

## 슬래시 명령

| 명령 | 효과 |
| --- | --- |
| `/pickup` | 새 자동 명명 세션 (`call-2026-05-04-1234`), 기본 음성 모드 |
| `/pickup name:planning mode:text model:claude-opus-4-7 effort:high` | 전체 vibecoding 설정으로 명명된 세션, 음성 참여 없음 |
| `/hangup` | 활성 컨테이너 종료 (음성 라인 또는 텍스트 채팅); 세션 보존 |
| `/resume name:planning` | 자동 모드 — 음성 채널에 있으면 음성, 아니면 텍스트 |
| `/sessions` | 최근 세션 목록 (최대 15개), 가장 최근 활동 순 |
| `/rename name:new-name` | 활성 세션 이름 변경 |

전체 표면은 [슬래시 명령](/ko/components/slash-commands) 참조 (`/model`, `/effort`, `/permissions`, `/notify`).

## 저장

`packages/bot/data/sessions.json`:

```json
{
  "sessions": [
    {
      "id": "9d8a...",
      "name": "planning",
      "createdAt": 1777694137387,
      "lastActiveAt": 1777695201000,
      "backendId": "9d8a...",
      "backend": "claude-code",
      "mode": "text",
      "model": "claude-opus-4-7",
      "effort": "high",
      "permissionMode": "bypassPermissions",
      "notify": true
    }
  ]
}
```

| 필드 | 비고 |
| --- | --- |
| `id` | 봇의 안정적인 내부 핸들 (UUID) |
| `name` | 슬러그화된 사람 친화적 이름 |
| `backendId` | 에이전트 백엔드가 재개에 사용. `claude-code`는 보통 `id`; codex는 첫 턴에 자신의 thread UUID 할당 |
| `backend` | 이 세션이 사용하는 에이전트 백엔드 (`claude-code`, `openai-compat` 등). 봇 재시작 후에도 유지되며 `/resume`이 존중 |
| `mode` | `voice` 또는 `text`. `/resume` 자동 모드의 시스템 프롬프트 + 컨테이너 선택 결정 |
| `model` | 선택적 세션별 모델 오버라이드 (예: `claude-opus-4-7`). `AGENT_MODEL` 환경 변수로 폴백 |
| `effort` | 선택적 추론 노력 힌트. `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `permissionMode` | 선택적 도구 권한 정책. `default` / `acceptEdits` / `auto` / `bypassPermissions` / `plan`. 미설정 시 모드 인식 기본값 적용 |
| `notify` | true면 확장 settle 이벤트가 TTS 공지(음성) 또는 텍스트 메시지(텍스트) 발생 |
| `streaming` | `off` (기본) / `summary` / `full`. 텍스트 턴의 세션별 실시간 진행 UI. [슬래시 명령 → /streaming](/ko/components/slash-commands#streaming-실시간-진행) 참조 |
| `reactivity` | `strict` (기본) / `loose` / `chatty`. 채널의 다른 봇들에 어떻게 반응할지. [멀티봇](/ko/components/multi-bot) 참조 |
| `channelId` | 텍스트 세션 전용: 이 세션이 바인딩된 Discord 채널 id. 자동 spawn 시 설정되어 재시작 후 첫 메시지에서 동일 세션 자동 재개 가능 |

모든 선택 필드는 미설정 시 JSON에서 생략됩니다 — 세션은 이전 스키마 버전에서 깔끔하게 forward 마이그레이션됩니다.

## 활성 컨테이너

두 개의 병렬 런타임 맵:

- `lines: Map<guildId, LineState>` — 음성 라인. 길드당 하나. 음성 연결, 오디오 플레이어, 스피커 에이전트, 마지막 인터랙션 보유.
- `textChats: Map<channelId, TextChat>` — 텍스트 채팅. 채널당 하나. 스피커 에이전트와 세션 레코드 보유.

`/pickup mode:voice`는 `LineState`를 등록; `/pickup mode:text`는 `TextChat`을 등록. `/hangup`은 이 길드/채널에서 활성인 것을 제거. 세션 자체는 어떤 경우든 `data/sessions.json`에 남음.

## `/model`, `/effort`, `/permissions`의 핫스왑

이 명령들은 봇을 재시작하거나 세션을 재생성하지 않습니다. 다음을 수행:

1. `Session`에 새 값을 영구 저장 (예: `Session.model = "claude-opus-4-7"`)
2. 활성 컨테이너의 현재 `SpeakerAgent` 인스턴스 중지
3. 업데이트된 옵션으로 새 `SpeakerAgent` 생성
4. `agent.start({ resume: true, ... })` 호출하여 백엔드가 이전 지점에서 계속

네이티브 세션을 가진 백엔드(claude-code, codex)의 경우 백엔드 재개가 전체 대화 히스토리를 보존. `anthropic-api`의 경우 히스토리는 인-메모리; 핫스왑이 이전 턴을 잃음. (향후 수정: 세션 레코드와 함께 `anthropic-api` 히스토리 영구 저장.)

## 대화 히스토리

히스토리 자체는 에이전트 백엔드가 저장하는 곳에 있습니다:

- **claude-code**: `~/.claude/projects/<hash>/<session-id>.jsonl`. 첫 턴에 `--session-id`, 이후 `--resume <id>` 전달.
- **codex**: `~/.codex/sessions/<thread-id>/`. 첫 JSONL 출력에서 할당된 thread id 캡처.
- **anthropic-api**: 인-메모리만 (영구 저장 없음). 오늘 `anthropic-api` 세션을 재개하면 신선한 상태 — TODO: 세션 레코드와 함께 메시지 히스토리 영구 저장.

이것이 `backendId` 필드가 `id`와 별도로 존재하는 이유입니다: 자신의 세션 저장소를 가진 백엔드들은 자신의 식별자가 필요하며, 우리는 이를 추적해야 합니다.
