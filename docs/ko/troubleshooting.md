# 문제 해결

봇은 계층화된 파이프라인입니다 — 장애는 보통 한 계층에서 발생합니다. 항상 로그부터 확인하세요:

```sh
bash packages/bot/bin/papercup status
bash packages/bot/bin/papercup tail 50
```

장애를 [파이프라인](/ko/architecture/pipeline) 단계에 매핑하고 아래 레시피를 따르세요.

## 부팅 실패

| 로그 줄 | 해결 |
| --- | --- |
| `Used disallowed intents` | Discord 개발자 포털 → Bot → Privileged Gateway Intents에서 **MESSAGE CONTENT INTENT** 활성화 |
| `Missing required env var: DISCORD_TOKEN` | `packages/bot/.env` 편집, 자격 증명 채우기 |
| `Cannot find module ...` | 저장소 루트에서 `npm install` |
| `[stt] sidecar exited` | Python venv 손상 — `npm run setup-venv` |
| `Load model from .../silero_vad.onnx failed` | `npm run download-models` 실행 |
| `Not logged in · Please run /login` (claude-code 백엔드) | 터미널에서 `claude /login` |

## 런타임 실패

### 봇이 음성에 응답하지 않음

로그에서 VAD 확률을 확인하세요. 말한 후:

```
[debug] s16 peak: <high>, f32 peak: <high>
[debug] first probs: [<low values>...]
[capture] noise-only (speech<3); skipping playback
```

`f32 peak`가 정상(>0.1)인데 VAD 확률이 모두 <0.05라면 Silero 컨텍스트 버퍼 로직을 의심하세요. `f32 peak`가 ~0이고 `s16 peak`가 정상이면 리샘플러를 의심하세요.

### 봇이 "파일에 접근할 수 없습니다"라고 말함

설계상 그렇습니다 — 스피커는 읽기 전용 도구만 가지며 작업은 확장에 위임합니다. 인라인 읽기를 허용하려면 `.env`에 `PROJECT_DIRS=/path/to/your/project`를 설정하고 재시작하세요. 그러면 스피커가 해당 경로에서 Read/Glob/Grep을 사용합니다.

### 응답 지연이 너무 길음

턴별 로그 분석:

```
[stt] req N: "..." (Xs audio in Ys, RTF=Z)
[agent] reply (Wms, ...)
[tts] req N: ... (Ums audio in Vs, RTF=...)
[agent] full loop: <total>ms
```

CLI 백엔드에서는 보통 에이전트 단계가 대부분을 차지합니다. API 키와 함께 `AGENT_BACKEND=anthropic-api`로 전환하면 턴당 ~5초 절약됩니다.

### 한국어 / 영어 외 언어가 전사되지 않음

`WHISPER_MODEL=base.en`은 영어 전용입니다. 다국어를 위해 `base`로 전환하세요. 한국어 TTS도 원하면 `TTS_ENGINE=auto`로 설정하세요 — Whisper의 감지된 언어에 따라 한국어는 MeloTTS, 그 외는 Kokoro로 라우팅됩니다. 자세한 내용은 [한국어](/ko/components/korean) 참조.

### MeloTTS 설치 실패

업스트림 핀 충돌(transformers 4.27.4 → cp312 휠 없음 → Rust 컴파일 오류). `packages/voice-stack/sidecar/install-melotts.sh` 헬퍼가 이 문제를 처리합니다 — 이를 호출하는 대신 직접 `pip install git+...`을 실행했다면 실패합니다. 다음을 사용하세요:

```sh
bash packages/voice-stack/sidecar/install-melotts.sh packages/voice-stack/sidecar/.venv
```

### 통화 중 캡처 루프가 응답을 멈춤

캡처는 opus 스트림 오류(DAVE 복호화 경쟁, 네트워크 결함)에서 재구독으로 자가 복구합니다. 봇이 침묵하고 1-2초 후에도 `[capture] subscribing`이 나타나지 않으면 회귀입니다 — `papercup tail 100` 출력과 함께 이슈를 등록해주세요.

### 확장이 영원히 실행됨

확장은 `--dangerously-skip-permissions`를 상속하므로 무제한 실행될 수 있습니다. `cat packages/bot/data/extensions.json`에서 항목을 확인하세요 — pid가 기록되어 있습니다. 정말 멈췄다면 `kill <pid>`. exit 핸들러가 failed로 표시할 것입니다.

## Claude Code 플러그인을 통한 진단 프로토콜

플러그인으로 설치된 경우, `papercup` 스킬이 진단 프로토콜을 자동 실행합니다. Claude Code 내부에서:

> "/papercup:status. 봇이 통화 중에 응답을 멈췄어요."

스킬이 파이프라인 단계를 따라가며 로그를 읽고 다음 디버깅 단계를 제안합니다.
