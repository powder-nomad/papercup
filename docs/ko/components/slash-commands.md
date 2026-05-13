# 슬래시 명령

Discord 슬래시 명령은 런타임에 Papercup을 조작하는 방법입니다. 총 19개. 봇은 재시작 시마다 길드별로 명령을 등록합니다 (스키마 변경 후에는 `npm run -w @papercup/bot register`).

## 빠른 참조

| 명령 | 기능 |
| --- | --- |
| `/pickup` | 세션 시작 (음성 또는 텍스트). `name`, `model`, `effort`, `permission-mode` 옵션 |
| `/hangup` | 활성 컨테이너 종료 (음성 라인 또는 텍스트 채팅); 세션은 `/resume`을 위해 보존 |
| `/resume name:<x>` | 자동 모드 — 컨텍스트로부터 음성/텍스트 결정 |
| `/cancel` | 활성 세션의 진행 중인 에이전트 프로세스 그룹에 SIGTERM |
| `/sessions` | 최근 세션 목록 |
| `/status` | 활성 세션의 설정 + 현재 실행 중인 백그라운드 확장 표시 |
| `/rename name:<x>` | 현재 세션 이름 변경 |
| `/say text:<x>` | 활성 음성 라인에 TTS로 텍스트 발화 |
| `/bind channel:<#chan>` | (관리자) 봇을 특정 텍스트 채널에 바인딩 — 해당 채널의 모든 메시지가 봇 트리거 |
| `/unbind` | (관리자) 바인딩 해제, @멘션으로 폴백 |
| `/model name:<x>` | 활성 세션의 에이전트 모델 핫스왑 |
| `/effort level:<x>` | 활성 세션의 추론 노력 핫스왑 |
| `/permissions mode:<x>` | 도구 권한 정책 핫스왑 |
| `/backend name:<x>` | 에이전트 백엔드 전환 (claude-code, codex, gemini-cli, openai-compat 등). 대화 기록 리셋 |
| `/models action:list\|refresh` | 알려진 모델→백엔드 매핑 표시; refresh는 제공자 API에서 재조회 |
| `/notify state:on\|off` | 확장 완료 시 알림 토글 (TTS/텍스트) |
| `/mcp` | 활성 세션이 호출할 수 있는 MCP 서버 도구 표시 또는 변경 |
| `/streaming mode:off\|summary\|full` | 텍스트 모드 턴의 실시간 진행 UI |
| `/reactivity mode:strict\|loose\|chatty` | 다른 봇들의 메시지에 어떻게 반응할지 |
| `/budget [set_usd:<n>]` | 오늘의 USD + 토큰 사용량 표시; 일일 캡 설정/해제 가능 |
| `/announce` | 이 봇의 구조화된 roster 항목을 `#roster` 채널에 게시 |
| `/refresh-roster` | `#roster` 채널을 재스크랩해 로컬 roster 재구성 |

## `/pickup` — 세션 시작

대화를 시작하는 단일 진입점. 음성 또는 텍스트, 모든 옵션을 한 번에 설정.

```
/pickup name:<string>?
        mode:voice|text                           (기본값: voice)
        model:<id>                                (예: claude-opus-4-7)
        effort:minimal|low|medium|high|xhigh|max
        permission-mode:default|acceptEdits|auto|bypassPermissions|plan
```

- **음성 모드** (기본): 음성 채널에 참여, 전화 통화 시스템 프롬프트 적용 (간결, 평이한 산문, 한국어=1문장), TTS 응답.
- **텍스트 모드**: 현재 채널에 세션 고정, 음성 참여 없음. **시스템 프롬프트 없음** — 에이전트가 일반 Claude Code 세션처럼 동작 (마크다운 OK, 다단락 OK). Discord 텍스트로 응답. `/bind`와 조합 가능 — 명시적 `/pickup mode:text`가 자동 생성된 채팅을 대체.
- 네 가지 모든 옵션(model/effort/permissionMode/mode)은 세션에 저장되며 `/hangup` → `/resume` 후에도 유지.
- 권한 모드 기본값은 모드별: `text` → `bypassPermissions` (vibecoding 흐름은 인터랙티브 프롬프트 처리 불가); `voice` → `default` (스피커는 주로 샌드박스 확장에 위임).

## `/resume` — 자동 모드

`/resume name:foo`는 컨텍스트에서 음성/텍스트를 결정합니다:

1. 이 길드에 활성 음성 라인 → 음성으로 재개
2. 이 채널에 활성 텍스트 채팅 → 텍스트로 재개 (백엔드 재개로 히스토리 보존)
3. `Session.mode`가 저장됨 → 그것을 사용
4. 현재 음성 채널에 있음 → 음성
5. 그 외 → 텍스트 (안전한 기본값)

결정은 로그에 기록: `[resume] "vibe" → text (activeVoice=false activeText=true sessMode=text memberInVoice=false)`.

## `/hangup`

이 길드/채널에 활성화된 컨테이너를 종료:
- 음성 라인 → 연결 해제, 세션 보존 표시
- 텍스트 채팅 → 채팅 해제, 세션 보존
- 둘 다 없음 → "활성 라인이나 텍스트 세션 없음."

세션 레코드는 `data/sessions.json`에 남습니다; `/resume`으로 다시 시작.

## `/model`, `/effort`, `/permissions`

세 명령 모두 활성 컨테이너(음성 라인 OR 텍스트 채팅)에서 작동하며 **에이전트를 핫스왑**합니다: 현재 백엔드 중지, 새 옵션으로 재시작, `resume: true`로 백엔드 히스토리 유지. 데이터 손실 없음.

```
/model name:claude-opus-4-7         # 모델 설정
/model name:                         # 클리어 (AGENT_MODEL env로 폴백)

/effort level:high                  # 높은 추론 예산
/effort level:default               # 오버라이드 클리어

/permissions mode:bypassPermissions # vibecoding 모드
/permissions mode:default-for-mode  # 오버라이드 클리어 (모드별 기본값 적용)
```

영속성: 각 설정은 `/hangup` → `/resume` 후에도 유지됩니다.

## `/notify`

켜져 있을 때, 봇은 활성 컨테이너에 확장 정착(완료 / 실패 / 중단)을 알립니다:
- 음성 라인 → 한 줄 음성 합성 ("auth-deploy가 4분 후 완료되었습니다. 요약 들으시겠습니까?") 후 재생
- 텍스트 채팅 → 요약(처음 400자)을 포함한 Discord 메시지 게시

```
/notify state:on
/notify state:off
```

기본값은 off; 명시적 on/off가 세션에 저장.

## `/say`

활성 음성 라인에 봇이 주어진 텍스트를 발화하도록 강제. TTS 테스트나 에이전트를 거치지 않는 일회성 공지에 유용.

```
/say text:안녕하세요, TTS 엔진 테스트입니다.
```

활성 음성 라인이 없으면 오류.

## `/bind` / `/unbind` (관리자 전용)

서버 전체 설정. 채널이 바인딩되면 그 채널의 모든 메시지가 프롬프트로 처리 — @멘션 불필요. 첫 메시지 시 자동 생성된 텍스트 채팅이 만들어지고, `/pickup mode:text`로 명명된 세션으로 교체 가능.

**서버 관리** 권한 필요. 상태는 `data/guild-config.json`에 저장.

## `/sessions`와 `/rename`

```
/sessions             # 최근 세션 목록, 가장 최근 활동 순
/rename name:vibe     # 현재 세션 이름 변경
```

`/sessions`는 최대 15개 항목을 상대 시간으로 표시. 이름은 슬러그화(소문자, 하이픈). `/rename`은 새 이름이 충돌하면 오류.

## `/cancel`

진행 중인 에이전트의 프로세스 그룹에 SIGTERM (claude/codex/aider 등 + 그 후손 — cloudflared, uvicorn 등). 이 채널/길드의 활성 세션에 적용. `/cancel`이 "Nothing in flight"를 반환하면 `data/process-registry.json`과 시스템 프로세스 목록을 확인하세요 — 진짜 고아 프로세스는 다음 재시작 후 부팅 리퍼가 정리.

## `/status`

활성 세션의 `model`, `effort`, `permissionMode`, `mode`와 봇 전체의 현재 실행 중인 백그라운드 확장 수를 보여주는 ephemeral 응답.

## `/backend` — 에이전트 백엔드 전환

```
/backend                            # 현재 + 등록된 10개 백엔드 목록 표시
/backend name:openai-compat         # 이 세션을 openai-compat로 전환
```

**대화 기록을 리셋합니다** (백엔드 간 세션 재개는 불가능 — claude-code 세션 id는 codex나 opencode에게는 의미 없음). 영구 저장되는 `session.backend` 필드는 봇 재시작 후에도 유지. [스피커 에이전트](/ko/components/speaker-agent) 참조.

## `/models` — 모델 카탈로그

```
/models                  # 기본 action = list
/models action:list      # 제공자별로 그룹화된 알려진 모델 표시
/models action:refresh   # Anthropic, OpenAI, Gemini API에서 실시간 모델 목록 재조회
```

일반 모델의 정적 카탈로그는 봇과 함께 제공됩니다. 실시간 `refresh`는 관련 API 키 필요 (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` / `OPENAI_COMPAT_API_KEY`, `GEMINI_API_KEY`). 각 모델 항목은 실행 가능한 백엔드 목록을 표시 — 예: `claude-opus-4-7 → [claude-code, anthropic-api]`.

## `/streaming` — 실시간 진행

```
/streaming                         # 활성 세션의 현재 모드 표시
/streaming mode:off                # 기본. 최종 응답만
/streaming mode:summary            # 단일 한 줄 sticky "🤔 Edit: foo.ts · 4 tools · 12s elapsed"
/streaming mode:full               # sticky 메시지 + 최근 8개 이벤트 스크롤, 인접 중복 합치기
```

텍스트 모드 세션에만 적용되고 `claude-code` 백엔드 전용 (`tool_use` / `tool_result` 이벤트를 스트리밍하는 유일한 백엔드). 안티-스팸: 1.5초 편집 throttle, 5초 미만 턴은 자동 건너뜀.

## `/reactivity` — 멀티봇 가드레일

```
/reactivity                        # 현재 + 봇 루프 카운터 표시
/reactivity mode:strict            # 기본. @-멘션이 있을 때만 다른 봇에 응답
/reactivity mode:loose             # @-멘션 없이도 다른 봇에 응답
/reactivity mode:chatty            # 예약 — 현재는 loose와 동일
```

사람 메시지는 영향받지 않음 — 기존 바인딩-채널 / @-멘션 규칙 그대로. 봇 루프 캡(`BOT_BOT_MAX_TURNS`, 기본 3)은 사람 턴 없이 연속으로 응답한 횟수가 그 수를 초과하면 papercup을 침묵시킴. [멀티봇](/ko/components/multi-bot) 참조.

## `/budget` — 비용 추적

```
/budget                            # 오늘의 USD + 토큰 + 7일 분석 표시
/budget set_usd:10                 # 일일 캡을 $10로 설정
/budget set_usd:0                  # 캡 비활성화
```

캡은 UTC 자정에 리셋. 예산 초과 시 사람은 명시적 "budget spent" 응답을 받고, 다른 봇은 무음 무시됨. 봇의 Discord rich-presence가 실시간으로 `46% of $10/day`를 표시. 가격은 Claude Opus/Sonnet/Haiku 4.x, GPT-5/4o/o3, Gemini 2.5 커버; 알려지지 않은 모델은 토큰만 기록.

## `/announce`와 `/refresh-roster` — 인-밴드 봇 roster

```
/announce                          # 이 봇의 roster 항목을 BOT_ROSTER_CHANNEL_ID에 게시
/refresh-roster                    # 그 채널 재스크랩 + workdir 겹침 검사
```

`BOT_ROSTER_CHANNEL_ID` 환경 변수가 필요. 안내는 구조화된 코드 블록 메시지(`papercup-roster v1`)로 bot_id, owner, workdir, reactivity, budget, fingerprint, public-key 포함. 다른 운영자들의 봇이 같은 채널을 스크랩해 서로를 발견. 아웃-오브-밴드 조정 불필요. [멀티봇](/ko/components/multi-bot) 참조.
