# 채널 바인딩

텍스트로 봇과 대화하는 두 가지 방법:

1. **어디서든 @-멘션** — 봇이 멘션된 곳에 응답
2. **단일 채널 바인딩** — 그 채널의 모든 메시지가 프롬프트; 봇이 다른 모든 것 무시

## 슬래시 명령 (관리자 전용)

| 명령 | 효과 |
| --- | --- |
| `/bind channel:#papercup` | 봇을 텍스트 채널에 바인딩 |
| `/unbind` | @-멘션 동작으로 폴백 |

둘 다 **서버 관리** 권한 필요. Discord는 슬래시 명령의 `setDefaultMemberPermissions(ManageGuild)`로 이를 강제; 봇은 또한 심층 방어로 코드에서 재확인.

## 길드별 설정

`packages/bot/data/guild-config.json`:

```json
{
  "guilds": {
    "<guild-id>": {
      "boundTextChannelId": "<channel-id>"
    }
  }
}
```

원자적 rename으로 영구 저장. 봇 재시작 후에도 유지.

## 라우팅 규칙

메시지가 도착하면:

1. 봇 메시지, DM (현재 길드 전용), 빈 콘텐츠 건너뛰기.
2. **길드에 바인딩 채널이 있고** 메시지가 그 안에 있으면 → 전체 메시지를 프롬프트로 취급.
3. **길드에 바인딩 채널이 있지만** 메시지가 다른 채널에 있으면 → 무시.
4. **바인딩 채널이 없고** 봇이 `@`-멘션되면 → 멘션 제거, 나머지를 프롬프트로 취급.
5. 그 외 → 무시.

프롬프트 추출 후:

- 그 길드에 `/pickup` 음성 라인이 활성이면 → 같은 스피커 에이전트로 라우팅. 봇이 채팅에 응답 **그리고** 음성으로 답변. (통화 중 채팅에 링크 드롭 → 봇이 그것에 대해 이야기 가능.)
- 그 외 → 채널별 텍스트 전용 `SpeakerAgent` 생성 (또는 재사용). 채팅에만 응답.

## 환경 변수 오버라이드

`.env`의 `BOT_TEXT_CHANNEL_ID`는 길드별 바인딩이 없는 길드에 대한 글로벌 폴백. 한 서버에서만 실행하는 경우 유용. 길드별 `/bind` 설정이 항상 우선.

## Privileged intent

DM 외부에서 메시지 콘텐츠를 읽으려면 Discord의 **MESSAGE CONTENT INTENT** privileged intent 필요. *Discord 개발자 포털 → your app → Bot → Privileged Gateway Intents*에서 활성화. 이게 없으면 봇이 `Used disallowed intents`로 연결 시 크래시.
