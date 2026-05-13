# 확장 서브에이전트

확장은 스피커와 계속 대화하는 동안 자율적으로 실행되는 백그라운드 Claude Code 인스턴스입니다. `data/extensions/<id>/` 샌드박스 디렉터리에 있고, 전체 도구 접근(`--dangerously-skip-permissions --allowedTools default`)을 받으며, 결과를 디스크에 영구 저장합니다.

## 턴이 흐르는 방식

1. 사용자가 "fibonacci를 출력하는 Python 스크립트를 만들어줘"라고 말함.
2. 스피커가 이것이 멀티 스텝 작업임을 인식하고 MCP 도구 `spawn_extension({task: "..."})`을 호출.
3. `ExtensionManager.spawn()`이 `data/extensions/<id>/`를 생성하고, 레코드를 작성하고, `cwd`가 샌드박스 디렉터리로 설정된 `claude -p "..."`를 spawn하고, 즉시 id를 반환.
4. 스피커가 "시작했어요, 잠시만요"라고 말함 — 확장 id가 `data/extensions.json`에 나타남.
5. `claude -p` 서브프로세스가 백그라운드에서 실행 — 30초가 걸릴 수도, 10분이 걸릴 수도.
6. 종료되면 `ExtensionManager`가 JSON 출력을 파싱하고 `result` 텍스트 + `total_cost_usd`를 캡처하고 레코드를 `completed`로 표시.
7. 사용자가 "다 됐어?"라고 물어보면 → 스피커가 `check_extension(id)`을 호출 → 상태에 따라 응답.

## MCP를 통해 노출된 도구

| 도구 | 목적 |
| --- | --- |
| `spawn_extension(task, name?)` | 비동기 작업 시작. `{id, name, status: "running", dir, startedAt}` 반환. |
| `check_extension(id)` | 현재 상태 + 요약 가져오기. id나 친숙한 이름 전달. |
| `list_extensions(limit?)` | 최근 확장들, 가장 최근 순. |

## 내장 HTTP MCP 서버

`packages/voice-stack/src/extensions/mcp-server.ts`는 in-process HTTP MCP 서버 (`@modelcontextprotocol/sdk`의 Streamable HTTP 전송). 봇이 부팅 시 시작하고, 임시 로컬호스트 포트를 선택하고, `--mcp-config`로 모든 `claude -p` 서브프로세스에 URL을 전달:

```json
{
  "mcpServers": {
    "papercup": {
      "type": "http",
      "url": "http://127.0.0.1:<random-port>/mcp"
    }
  }
}
```

서버는 `127.0.0.1`에만 바인딩 — 절대 네트워크에 노출되지 않음. 세션은 표준 MCP 세션 id 헤더를 통해 요청별로 처리.

## Settle 이벤트 + `/notify`

`ExtensionManager`는 `EventEmitter`를 확장하고 확장이 실행 상태를 벗어날 때 (completed / failed / interrupted) `"settled"`를 발생시킵니다. 봇은 부팅 시 전역으로 구독:

```ts
extensions.on("settled", (ext) => {
  // 음성 라인: /notify가 켜져 있으면 한 줄 완료 공지 발화.
  for (const [, state] of lines) {
    if (state.session.notify) void announceExtensionSettledVoice(state, ext);
  }
  // 텍스트 채팅: 채널에 Discord 메시지 드롭.
  for (const [channelId, chat] of textChats) {
    if (chat.session.notify) void announceExtensionSettledText(channelId, chat, ext);
  }
});
```

세션에 `/notify state:on`이 설정되면, settle 이벤트가 다음으로 표시:
- **음성 라인** → TTS 공지: "auth-deploy가 4분 만에 끝났어요. 요약 듣고 싶으세요?"
- **텍스트 채팅** → 확장의 `summary` 처음 400자가 포함된 Discord 메시지

기본값은 off. 정확한 토글은 [슬래시 명령](/ko/components/slash-commands#notify) 참조.

## 영구 저장

`data/extensions.json`:

```json
{
  "extensions": [
    {
      "id": "8d08ba4f",
      "name": "create-hello-txt",
      "task": "hello.txt라는 파일을 'hi from papercup' 내용으로 생성",
      "status": "completed",
      "dir": ".../data/extensions/8d08ba4f",
      "pid": 793111,
      "startedAt": 1777694137387,
      "finishedAt": 1777694149658,
      "durationMs": 12271,
      "summary": "`hello.txt`를 ...에 생성",
      "costUsd": 0.184
    }
  ]
}
```

봇 프로세스 바운드: 확장 실행 중 봇이 죽으면 다음 부팅 시 `interrupted`로 표시. 아직 봇 재시작에 걸친 확장 분리는 시도하지 않음.

## 현재 샌드박싱

각 확장은 `data/extensions/<id>/`에서 `--dangerously-skip-permissions`로 실행. 샌드박스 내부에서는 전체 도구 접근. 외부에서는 아무것도 없음 — 기본적으로 사용자 프로젝트 경로에 `--add-dir` 없음. 확장이 실제 프로젝트에서 작동하기를 원한다면, [명시적 설정 결정](/ko/config)이 필요 (TODO).

## 미래 방향

디자인 문서에 따르면 확장은 결국 대상 리포지토리의 **git worktree**에서 실행되어야 합니다 (그래서 브랜치에서 프로젝트를 안전하게 편집하고 diff를 리뷰할 수 있게). 현재 구현은 더 간단한 v1.
