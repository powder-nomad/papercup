# Papercup 설치

세 가지 경로 모두 동일한 봇을 실행합니다. 환경에 맞는 것을 선택하세요.

## 요구사항

- **Node 20+** (봇)
- **Python 3.10+** (Whisper + Kokoro 사이드카)
- **espeak-ng** (Kokoro 음성화 의존성) — `apt-get install espeak-ng` 또는 `brew install espeak-ng`
- Linux의 경우 네이티브 Node 의존성을 위한 **build-essential + python3-dev**
- 다음 중 하나: 로그인된 `claude` CLI, 로그인된 `codex` CLI, 또는 **Anthropic API 키**

## 디스크 + 메모리

| 항목 | 디스크 |
| --- | --- |
| Node 의존성 | ~250 MB |
| Python venv (faster-whisper + kokoro-onnx) | ~700 MB |
| 음성 모델 (Silero, Kokoro, 보이스) | ~355 MB |
| **합계** | **~1.3 GB** |

메모리: 유휴 상태에서 ~1 GB 상주, 부하 시 더 많이 사용.

## 경로 선택

- **[원라이너 설치 →](/ko/install/one-liner)** 가장 빠름. 홈페이지의 폼이 맞춤 `bash <(curl ...)` 명령을 생성합니다.
- **[Claude Code 플러그인 →](/ko/install/cc-plugin)** `/papercup:setup` 슬래시 명령으로 설정. Claude Code를 주로 사용한다면 가장 적합.
- **[독립 실행 (수동) →](/ko/install/standalone)** clone, npm, venv, 모델, .env — 명시적 단계별 안내.
- **[OpenClaw 플러그인 →](/ko/install/openclaw)** 준비 중 — Papercup의 음성 스택을 OpenClaw 스킬로.
