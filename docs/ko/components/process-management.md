# 프로세스 관리

모든 CLI 에이전트 턴(claude-code, codex, aider, gemini-cli, opencode, crush, amp)은 실제 OS 프로세스를 spawn합니다. Papercup은 이를 추적해야 합니다 — 깨끗하게 취소하고, 크래시로부터 고아 없이 복구하며, "지금 실제로 무엇이 실행 중인가"를 표시하기 위해.

## 구성 요소

### Detached spawn

CLI 에이전트는 `detached: true`로 spawn되어 자신의 프로세스 그룹 리더가 됩니다. 봇이 *전체 트리*에 SIGTERM을 보낼 수 있도록 하기 위함입니다 (claude + 그것이 spawn한 모든 손자 — cloudflared, uvicorn 등) — 한 번의 `process.kill(-pid, "SIGTERM")`으로. detached 없이는 claude를 죽여도 자식 프로세스가 살아남습니다 — 한 번은 20시간짜리 cloudflared 좀비를 만든 바로 그 버그입니다.

### 프로세스 레지스트리

`data/process-registry.json`이 spawn된 모든 PID를 기록:

```json
{
  "entries": [
    {
      "pid": 215593,
      "startedAt": 1762870276000,
      "sessionId": "6e510261-a6d3-4502-83d0-5b01890997f6",
      "botPid": 161422,
      "commandPreview": "claude: Go through the rest of Batch B steps…"
    }
  ]
}
```

`ProcessRegistry.register()`를 통해 각 `spawn()` 직후에 기록되고, settle 시 unregister됩니다. 원자적 쓰기 (tmp + rename). 봇은 `process.pid`로 자신의 PID를 식별하므로 부팅 리퍼는 *이전에* spawn된 것을 알 수 있습니다 (행의 `botPid !== currentBotPid`인 경우).

### 부팅 시 리퍼

시작 시 `processRegistry.reapOrphans(process.pid)`가 레지스트리를 순회합니다. 다른 `botPid`를 가진 각 항목에 대해:

1. `kill -0 pid` — 아직 살아 있는가? 아니면 항목 제거.
2. `/proc/<pid>/cmdline` 읽기 — `claude` (또는 해당 CLI)처럼 보이는가? PID 재사용 방지: 재활용된 PID를 우연히 차지한 관련 없는 프로세스가 SIGTERM되지 않도록 보호.
3. `process.kill(-pid, "SIGTERM")` — 그룹 kill.
4. 항목 제거.

**중요한 안전 규칙:** 리퍼는 *레지스트리에 있는* PID만 건드립니다. 절대 전역으로 `pgrep claude -p`하지 않습니다 — 그러면 다른 운영자의 터미널 claude, 병렬 에이전트, MCP-spawn된 서브-claude를 죽일 위험이 있습니다.

### `/cancel`

활성 세션의 진행 중인 에이전트 프로세스 그룹에 SIGTERM 전송. 봇이 자식(`ChildProcess`)에 대한 참조를 여전히 가지고 있는 한 작동합니다. 참조가 손실되면 (예: await Promise가 예기치 않게 reject), `/cancel`은 "Nothing in flight"를 보고합니다 — 그 고아는 재시작 후 레지스트리 + 리퍼가 커버합니다.

### 턴별 타임아웃 (선택)

`PAPERCUP_TURN_TIMEOUT_S` (기본 `0` = 비활성)는 각 턴을 N초로 캡합니다. 타임아웃 시 동일한 그룹 kill이 발생하고 턴이 `turn timed out after Ns`로 reject됩니다. 합리적인 캡을 넘어가는 적법한 작업 — 설치 스크립트, 포그라운드 cloudflared, 긴 확장 관리 — 때문에 기본값은 비활성화; 안전망이 필요할 때 opt-in.

## 왜 레지스트리가 인-밴드인가, /tmp가 아닌

`/tmp`의 프로세스 추적 파일은 재부팅 시 정리됩니다 — 정확히 가장 유용해야 할 때 (크래시에서 살아남은 고아를 식별하기 위해). `data/`는 영구적이며 레지스트리는 깨끗하지 않은 종료에서도 살아남습니다.

## 레지스트리가 도움이 되는 시점

- **봇이 턴 중간에 크래시 → claude가 계속 실행 중.** 봇 재시작 시 리퍼가 `botPid` 불일치 + `/proc/cmdline` 검증으로 고아 발견.
- **`/cancel`이 "nothing in flight"를 말하지만 프로세스가 보인다.** 터미널에서 수동 `kill <pid>`는 안전합니다 — 레지스트리는 추적만 할 뿐, 셸에서 PID로 직접 취소하는 데 항목이 꼭 필요하지는 않습니다.
- **무엇이 실행 중인지 감사하고 싶다.** `cat data/process-registry.json`이 현재 상태를 표시.

## 관련

- [슬래시 명령 → /cancel](/ko/components/slash-commands#cancel)
- [설정 → 프로세스 관리](/ko/config#프로세스-관리)
