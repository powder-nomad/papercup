# 슬래시 명령

Discord 슬래시 명령은 런타임에 Papercup을 조작하는 방법입니다. 총 12개. 봇은 재시작 시마다 길드별로 명령을 등록합니다 (스키마 변경 후에는 `npm run -w @papercup/bot register`).

## 빠른 참조

| 명령 | 기능 |
| --- | --- |
| `/pickup` | 세션 시작 (음성 또는 텍스트). `name`, `model`, `effort`, `permission-mode` 옵션 |
| `/hangup` | 활성 컨테이너 종료 (음성 라인 또는 텍스트 채팅); 세션은 `/resume`을 위해 보존 |
| `/resume name:<x>` | 자동 모드 — 컨텍스트로부터 음성/텍스트 결정 |
| `/sessions` | 최근 세션 목록 |
| `/rename name:<x>` | 현재 세션 이름 변경 |
| `/say text:<x>` | 활성 음성 라인에 TTS로 텍스트 발화 |
| `/bind channel:<#chan>` | (관리자) 봇을 특정 텍스트 채널에 바인딩 — 해당 채널의 모든 메시지가 봇 트리거 |
| `/unbind` | (관리자) 바인딩 해제, @멘션으로 폴백 |
| `/model name:<x>` | 활성 세션의 에이전트 모델 핫스왑 |
| `/effort level:<x>` | 활성 세션의 추론 노력 핫스왑 |
| `/permissions mode:<x>` | 도구 권한 정책 핫스왑 |
| `/notify state:on\|off` | 확장 완료 시 알림 토글 (TTS/텍스트) |

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
