# 원라이너 설치

[홈페이지](/ko/)의 폼이 엔진 선택이 사전 설정된 `bash <(curl ...)` 명령을 생성합니다. 복사하여 홈랩 터미널에 붙여넣고, Discord 자격 증명 프롬프트를 따라가세요.

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/powder-nomad/papercup/main/install.sh) \
  --agent claude-code \
  --stt whisper-base \
  --tts auto \
  --voice af_heart
```

## 전체 플래그

```
--dir <path>              설치 위치. 기본값: $HOME/papercup
--branch <name>           Git 브랜치. 기본값: main
--discord-token <token>   봇 토큰 (없으면 프롬프트)
--discord-client-id <id>  애플리케이션 ID (없으면 프롬프트)
--discord-guild-id <id>   서버 ID (없으면 프롬프트)

--agent <name>            claude-code (기본) | codex | anthropic-api
--model <name>            haiku (기본), sonnet, opus, gpt-5 등
--anthropic-api-key <k>   --agent=anthropic-api일 때만 필요

--vad <name>              silero (기본; 현재 유일한 옵션)
--stt <name>              whisper-base (기본, 다국어) | whisper-base.en |
                          whisper-small.en | whisper-small
--tts <name>              auto (기본, ko→MeloTTS·기타→Kokoro) | kokoro | melotts
--voice <name>            af_heart (기본) — 아래 Kokoro 보이스 참조

--silence-ms <int>        발화 종료 무음 (ms). 기본값: 600
--vad-threshold <float>   음성 확률 임계값. 기본값: 0.4

--skip-models             음성 모델 다운로드 건너뛰기
--skip-venv               Python venv 생성 건너뛰기
--skip-register           Discord에 슬래시 명령 푸시 건너뛰기
--no-start                설치만; 데몬 시작 안 함
--yes / -y                모든 기본값 수락; 프롬프트 없음
```

## 설치 스크립트가 하는 일

스크립트는 멱등적입니다. 다른 플래그로 언제든 재실행해 재구성할 수 있습니다.

1. **검사**: node 20+, python3, espeak-ng, claude/codex CLI 확인 (없으면 경고)
2. **`powder-nomad/papercup` 클론 또는 업데이트** → `--dir`
3. **Discord 자격 증명**: 플래그 → 기존 `.env` → 프롬프트 순서로 가져옴
4. **`packages/bot/.env` 작성** — 지정한 모든 값으로
5. **`npm install`** — 워크스페이스 루트에서
6. **Python venv** — `packages/voice-stack/sidecar/.venv` (가장 느린 단계, ~700MB 휠)
7. **MeloTTS 설치** (한국어/`auto` TTS 선택 시) — `install-melotts.sh` 헬퍼가 처리
8. **모델 다운로드** (Silero VAD, Kokoro TTS, Kokoro 보이스 — ~355MB)
9. **Discord 서버에 슬래시 명령 등록**
10. **기능 매트릭스 출력** (실제로 동작하는 언어/보이스)
11. **데몬 시작**

## 설치 후

데몬 관리:

```sh
bash $HOME/papercup/packages/bot/bin/papercup status
bash $HOME/papercup/packages/bot/bin/papercup logs    # tail -F
bash $HOME/papercup/packages/bot/bin/papercup tail 50
bash $HOME/papercup/packages/bot/bin/papercup stop
bash $HOME/papercup/packages/bot/bin/papercup restart
```

Discord에서:

```
/pickup name:planning      ← 새 세션 (이름 지정)
/hangup                    ← 세션 보존
/resume name:planning      ← 나중에 이어가기
/sessions                  ← 최근 세션 목록
/rename name:foo           ← 현재 세션 이름 변경
/bind channel:#papercup    ← 관리자: 해당 채널의 모든 메시지를 봇으로
/say text:안녕             ← TTS로 텍스트 발화
```
