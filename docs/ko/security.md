# 보안

Papercup은 봇의 Linux 사용자로 LLM 에이전트를 실행하며, 그 에이전트의 도구(Bash, Edit, Write, 서브에이전트 등)는 Discord 채팅으로 도달 가능합니다. **봇에 메시지를 보낼 수 있는 누구나 에이전트를 조작할 수 있습니다.** 이 페이지는 신뢰 모델과 배포를 안전하게 만드는 레버를 다룹니다.

## 한 단락 위협 모델

Discord 인증이 외곽 경계입니다. 그 안에서 **프롬프트 인젝션**이 에이전트의 도구 표면을 통해 닿을 수 있는 무엇이든 실행하도록 유도할 수 있습니다. 봇의 Linux 사용자(그리고 봇의 작업 디렉터리, 환경, `PROJECT_DIRS`)가 내부 경계입니다. "에이전트가 거부할 것이다"라는 방어책은 없습니다 — 에이전트는 도움이 되려고 노력합니다. 대신 도달 가능한 것을 잠그세요.

## 코드 수준 감사 (양호)

코드 자체는 클래식 명령 인젝션이 없습니다:

- 모든 `spawn()` 호출은 **배열 형태 인자** 사용 — 절대 셸 해석 문자열 아님
- `shell: true` 0개
- `child_process.exec()` (셸 평가 버전) 0개
- `eval()` / `new Function()` 0개

`"; rm -rf /; "` 같은 조작된 사용자 입력도 셸이 아닌 LLM에 평문으로 도달합니다. 아래 위험은 LLM 수준이지 코드 수준이 아닙니다.

## 필수: 사용자 허용 목록

**다른 Discord 사용자에게 봇을 노출하는 모든 배포 전에 설정하세요**:

```env
BOT_ALLOWED_USERS=1452485937756901519,179823948572394857
```

쉼표 구분 Discord 사용자 ID. 설정되면:
- 다른 누구의 슬래시 명령은 거부 응답
- 다른 누구의 채널 메시지는 조용히 무시

빈 값/미설정은 하위 호환 기본값 (모두 허용). 완전히 통제하지 않는 서버에 봇을 추가했다면 허용 목록을 설정하세요.

## 확장 샌드박스

`spawn_extension`은 봇의 Linux 사용자로 백그라운드 `claude -p`를 실행합니다. 세 가지 환경 변수로 잠금 정도를 제어:

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `EXTENSION_PERMISSION_MODE` | `bypassPermissions` | `default` / `acceptEdits` / `auto` / `bypassPermissions` / `plan`. 기본값은 모든 권한 검사 건너뜀 (확장은 무인 실행; default/acceptEdits는 위험한 도구에서 멈춤). `default`를 명시적 `EXTENSION_ALLOWED_TOOLS`와 페어링하여 더 엄격한 제어. |
| `EXTENSION_ALLOWED_TOOLS` | `default` | 화이트리스트. 예: `"Read Edit Write Bash(npm *) Bash(git *)"` — 확장이 이것만 받음. |
| `EXTENSION_DISALLOWED_TOOLS` | — | 명시적 거부. 예: `"WebFetch Bash(curl *) Bash(rm -rf *)"`로 유출 + 파괴 차단. |

합리적으로 강화된 배포:

```env
EXTENSION_PERMISSION_MODE=default
EXTENSION_ALLOWED_TOOLS=Read Edit Write Bash(npm *) Bash(git *) Bash(node *) Bash(pnpm *)
EXTENSION_DISALLOWED_TOOLS=WebFetch
```

확장은 `cwd`를 `data/extensions/<id>/`로 샌드박스화하고 해당 경로에 대해 `--add-dir`을 전달합니다. `default` 권한 모드에서 claude는 샌드박스 + add-dir 외부 쓰기를 거부합니다. `bypassPermissions`에서는 범위를 무시합니다.

## 스피커 권한 정책

같은 `--permission-mode` 플래그가 **스피커** 자체(텍스트 모드 vibecoding)를 구동:

- 음성 모드 기본: `default` (스피커는 주로 확장에 위임; bash 드물게)
- 텍스트 모드 기본: `bypassPermissions` (vibecoding 흐름은 인터랙티브 프롬프트 처리 불가)

세션별 오버라이드는 `/permissions mode:<choice>`. [슬래시 명령](/ko/components/slash-commands)을 참조하세요.

## 시크릿

봇은 `packages/bot/.env`를 읽습니다 — Discord 토큰, 선택적 Anthropic API 키. 두 가지 경계 고려사항:

1. **에이전트의 Read 도구는 `cwd`, `--add-dir` 경로, 또는 `PROJECT_DIRS`의 모든 파일을 가져올 수 있습니다.** `.env`가 `cwd`에 있고(있음) 스피커가 Read 접근권을 가지면(가짐), 프롬프트 인젝션이 응답으로 토큰을 유출할 수 있습니다.
2. **`PROJECT_DIRS`에 `.env`를 넣지 마세요** — 그게 스피커의 인라인 파일 조회 읽기 범위입니다.

당신만이 허용된 사용자인 홈랩 배포에서 실용적 위험은 낮습니다. 공개/공유 배포의 경우:
- `BOT_ALLOWED_USERS` 채워진 상태 유지
- 최소 home-dir 내용을 가진 전용 Linux 사용자(예: `papercup`)로 봇 실행
- `.env`를 봇의 `cwd` 외부에 저장하고 `dotenv/config` 대신 systemd/프로세스 환경으로 전달
- 허용 목록 없이 공개 서버에 봇이 운영된 적이 있다면 `DISCORD_TOKEN`과 `ANTHROPIC_API_KEY` 회전

## 네트워크 표면

- **Discord WebSocket** (송신): 봇이 메시지를 받고 응답을 보내는 방법
- **HF / 모델 다운로드** (송신): 첫 설치 시 1회
- **임베디드 MCP 서버** (수신): `127.0.0.1`에만 바인딩, 임시 포트. 봇의 자식 claude 프로세스만 연결. LAN/인터넷에 노출 안 됨.
- **그 외 인바운드 HTTP 없음.** localhost MCP 서버 외에 봇은 청취 포트를 열지 않습니다.

## Discord 채널 범위

`/bind`는 봇이 채널의 **모든** 메시지를 듣게 합니다. 바인딩된 채널이 Discord 역할 권한으로 게이트되지 않으면 서버의 누구나 에이전트를 조작할 수 있습니다. `/bind`를 다음과 결합:

1. 비공개/역할 게이트 채널
2. `BOT_ALLOWED_USERS` 채워진 상태
3. `EXTENSION_PERMISSION_MODE=default` + 엄격한 `EXTENSION_ALLOWED_TOOLS` 목록

## 알려진 약점 (아직 미수정)

- **텍스트 모드에 인터랙티브 권한 UI 없음.** 텍스트 모드 기본값이 `bypassPermissions`인 이유는 대안(`default`)이 파이프된 stdio가 처리할 수 없는 프롬프트에서 멈추기 때문. 올바른 해결책은 권한 요청을 `[허용]/[거부]` 버튼으로 표시하는 [Discord 버튼 UI](https://github.com/powder-nomad/papercup/issues). 별도 추적; 텍스트 모드를 사용하는 모든 공개 배포 전에 필수.
- **Anthropic API 백엔드는 도구별 게이트 없음** — 동작 제약을 시스템 프롬프트에 의존. `BOT_ALLOWED_USERS` 채워진 상태에서 사용.
- **확장 stdout 캡처 + 표시.** 긴 확장 로그에는 도구 출력이 포함; 악의적 확장이 요약을 통해 데이터를 유출하면 그 데이터는 `/sessions` 목록과 알림 메시지에서 보입니다.

## 빠른 체크리스트

봇을 공개로 전환하기 전에 이 목록을 따라가세요:

- [ ] `BOT_ALLOWED_USERS` 설정됨
- [ ] `EXTENSION_PERMISSION_MODE`가 `default` 또는 `acceptEdits` (`bypassPermissions` 아님)
- [ ] `EXTENSION_DISALLOWED_TOOLS`에 `WebFetch`와 명백한 위험 포함
- [ ] `.env` 권한이 `600`, 봇 사용자만 소유
- [ ] 봇이 최소 home-dir 내용을 가진 전용 비특권 사용자로 실행
- [ ] `PROJECT_DIRS`가 봇 자체 디렉터리 미포함
- [ ] `/bind` 사용 시 채널이 역할 게이트됨
- [ ] 마지막 허용 목록 없는 공개 기간 이후 토큰 회전됨 (있는 경우)
