# 멀티봇 오케스트레이션

여러 papercup 봇이 하나의 Discord 서버에 공존할 수 있습니다. 각자 다른 운영자가 소유하고, 각자 다른 머신에서 고유한 자격 증명/모델/예산을 사용합니다. Discord가 메시지 버스가 되며, 사람이 실시간으로 협상을 보고 조정할 수 있습니다.

이 페이지는 출시된 내용을 다룹니다. 전체 디자인과 미구현 단계는 [`docs/design-notes/multi-bot-orchestration.md`](https://github.com/powder-nomad/papercup/blob/main/docs/design-notes/multi-bot-orchestration.md)에 있습니다.

## 현재 출시된 내용

### 루프 캡 (Phase 1)

`BOT_BOT_MAX_TURNS` (기본 `3`). 마지막 사람 메시지 이후 papercup이 연속으로 응답한 채널별 카운터. 카운터가 캡 이상이고 다른 봇이 발언하면 papercup은 메시지를 무시합니다. 사람 메시지는 카운터를 0으로 리셋합니다.

### 반응성 모드 (Phase 1)

세션별, `/reactivity mode:<strict|loose|chatty>`로 설정. 이 봇이 *다른* 봇의 메시지에 어떻게 반응하는지 제어합니다 — 사람 메시지는 항상 기존 바인딩-채널 / @-멘션 규칙을 따릅니다.

| 모드 | 동작 |
| --- | --- |
| `strict` (기본) | 다른 봇이 @-멘션하지 않으면 무시 |
| `loose` | @-멘션 없이도 다른 봇에 응답 |
| `chatty` | 예약 — 현재는 loose와 동일 |

### 멘션 허용 목록 (Phase 1)

`BOT_ALLOWED_USERS`는 이미 슬래시 명령을 게이팅합니다; 같은 환경 변수가 이제 메시지의 @-멘션도 게이팅합니다 (다른 봇 포함). 악의적 사용자의 토큰 고갈 공격 방지: 허용 목록에 없는 봇은 반응성 모드와 관계없이 무시됩니다.

### 예산 추적 (Phase 2)

각 봇은 `data/budget.json`에 일별 토큰 + USD 사용량을 추적:

```json
{
  "budgetUsd": 10.0,
  "usage": [
    { "date": "2026-05-12", "inputTokens": 12345, "outputTokens": 6789, "costUsd": 0.42 }
  ]
}
```

30일 롤링 히스토리. 일반 모델용 가격 스냅샷 (Claude Opus/Sonnet/Haiku 4.x, GPT-5/4o/o3, Gemini 2.5)이 `agent/budget.ts`에 포함; 알려지지 않은 모델은 토큰만 기록.

하드 캡 동작:
- 사람에게는 명시적 "💸 budget spent" 응답
- 다른 봇은 무음 무시
- 캡은 UTC 자정에 리셋

`BOT_DAILY_BUDGET_USD` 환경 변수 또는 런타임 `/budget set_usd:<n>`으로 설정.

### Rich-presence 브로드캐스트 (Phase 2)

봇의 Discord 활동 상태에 `46% of $10/day` (캡 설정 시) 또는 `12k tokens today` (캡 없을 때)가 표시됩니다. 사람이 봇 호버 시 보이고 다른 봇은 Discord API로 읽을 수 있습니다. 매 응답 후 업데이트. 멘션 스팸 없음, 슬래시 명령 UI 어수선함 없음.

### 인-밴드 roster (Phase 3)

`BOT_ROSTER_CHANNEL_ID`를 지정된 `#roster` 채널로 설정. 각 운영자가 `/announce`를 한 번 실행하면 자신의 봇이 구조화된 소개를 게시:

```
papercup-roster v1
bot_id: 1234567890
owner: <@123456789012345678>
workdir: /home/operator/workspaces/foo
reactivity: strict
budget: $10/day
fingerprint: DDvzs4P1am30KSRN
public_key: MCowBQYDK2VwAyEA...
```

봇 시작 시 (그리고 `/refresh-roster` 호출 시) papercup이 해당 채널의 최근 메시지를 스크랩하고, `papercup-roster v1` 블록을 파싱해 로컬 roster를 구성합니다. 각 항목은 Discord 봇-id로 키 지정.

**아웃-오브-밴드 조정 불필요.** 운영자들은 어느 채널이 `#roster` 채널인지만 합의하면 됩니다.

### Workdir 겹침 검사 (Phase 3)

부팅 시 papercup이 선언된 `BOT_WORKDIR` (기본값은 `process.cwd()`)을 다른 모든 roster 항목의 workdir과 비교합니다. 다음 경우 경고를 로그:

- 정확히 일치 (`/foo` vs `/foo`)
- 우리가 그들 안에 있음 (`/foo/bar` vs `/foo`)
- 그들이 우리 안에 있음 (`/foo` vs `/foo/bar`)

**로그만, 부팅 실패 없음** — 단일 봇 운영에서는 매번 경고할 것이기 때문. 새로운 운영자를 추가할 때는 시작 로그를 읽으세요.

### 암호화 신원 (Phase 4, 일부)

각 봇은 첫 부팅 시 영구 Ed25519 키쌍을 생성하고 `data/bot-identity.json` (chmod 0600)에 저장합니다. 공개 키 + fingerprint가 `/announce`에 포함됩니다. 서명/검증 핸드셰이크 프로토콜은 **연기됨** — 공개 키는 지금 캡처되어 나중에 봇 측 마이그레이션 없이 프로토콜을 추가할 수 있습니다.

```
fingerprint: DDvzs4P1am30KSRN   # SHA-256(public_key), base64url, 첫 16자
```

## 아직 출시되지 않은 내용

[`design-notes/multi-bot-orchestration.md`](https://github.com/powder-nomad/papercup/blob/main/docs/design-notes/multi-bot-orchestration.md) 참조:

- **Phase 4 암호화 핸드셰이크** — 실제 sign-and-verify 프로토콜. 기반(키쌍)은 마련됨; 복잡성을 정당화하는 학대 패턴이 나타날 때까지 연기.
- **Phase 5 라이브 두 봇 통합 테스트** — 운영자들이 만나 두 봇으로 한 시간 동안 감독된 실행을 진행.
- **도구 충돌 프로토콜** — 디자인 노트는 완벽한 해결책이 없음을 인정; 현재 완화는 workdir 격리 + 겹침 경고.
- **채널별 Discord 속도 제한 큐** — 장황한 봇 폭주가 여전히 Discord의 throttle을 트리거할 수 있음. 현재 우회: 반응성을 `strict`로 설정.

## 관련

- [슬래시 명령 → /reactivity, /budget, /announce, /refresh-roster](/ko/components/slash-commands)
- [설정 → 멀티봇 오케스트레이션](/ko/config#멀티봇-오케스트레이션)
- 디자인 노트: [`docs/design-notes/multi-bot-orchestration.md`](https://github.com/powder-nomad/papercup/blob/main/docs/design-notes/multi-bot-orchestration.md)
