---
title: 한국어 (및 기타 비-Kokoro 언어)
---

# 한국어

Papercup은 v0.2부터 한국어를 처음부터 끝까지 지원합니다. 영어와 동일한 파이프라인이지만 두 가지 조정이 있습니다.

## STT: 다국어 Whisper

기본 모델이 이제 `WHISPER_MODEL=base` (다국어)입니다. Whisper는 발화별로 입력 언어를 자동 감지하고 `transcript.lang`으로 반환합니다. `base.en` 대신 `base`를 기본값으로 하는 것 외에는 추가 설정이 필요 없습니다.

`base`는 `base.en`보다 약간 느리지만(4코어 CPU에서 ~0.4 RTF 대 0.3) 한국어에 충분히 정확합니다. 정확도가 중요하면 `WHISPER_MODEL=small`로 올리세요. `small.en`은 영어 전용이고 더 빠릅니다.

## TTS: MeloTTS (Kokoro가 한국어를 지원하지 않기 때문)

Kokoro v1.0은 9개 언어를 지원하지만 한국어는 그중에 없습니다. 따라서 한국어 출력은 **MeloTTS** (MyShell, MIT 라이선스)를 사용하며, 한국어 모델로 고정되어 있습니다.

권장하는 `TTS_ENGINE=auto` 구성은 두 엔진을 모두 실행하고 Whisper의 감지된 언어에 따라 발화별로 라우팅합니다:

| 감지된 언어 | 엔진 |
| --- | --- |
| `ko` | MeloTTS (한국어) |
| 그 외 | Kokoro |

MeloTTS는 **지연 부팅**됩니다 — Python+PyTorch+BERT-한국어 스택은 첫 한국어 발화에서만 로드됩니다. 영어만 사용하는 세션에서는 비용을 지불하지 않습니다.

첫 한국어 발화: MeloTTS가 부팅되는 동안 ~17–60초 정지. 이후: ~0.5–2.3 RTF (CPU에서 거의 실시간).

## 에이전트: 사용자 언어와 일치

스피커 에이전트의 시스템 프롬프트는 사용자가 말한 언어로 답하라고 지시합니다. 따라서 한국어 입력 → 한국어 답변 → MeloTTS가 한국어로 발화. 번역 단계 없음.

## 설치 사전 요구사항

MeloTTS는 PyTorch (~700MB)를 끌어오고 일본어 토큰화를 위해 MeCab을 사용합니다. 한국어만 합성할 때도 설치에는 시스템 라이브러리가 필요합니다:

```sh
# Linux
sudo apt-get install -y libmecab-dev mecab-ipadic-utf8 libssl-dev pkg-config

# macOS
brew install mecab mecab-ipadic openssl pkg-config
```

그런 다음 `--tts auto` 기본값으로 `install.sh`를 실행하거나 (자동으로 MeloTTS 설치 헬퍼 실행), 기존 설치를 업그레이드:

```sh
cd ~/papercup
bash packages/voice-stack/sidecar/install-melotts.sh packages/voice-stack/sidecar/.venv
# packages/bot/.env 편집: TTS_ENGINE=auto, WHISPER_MODEL=base
bash packages/bot/bin/papercup restart
```

헬퍼는 업스트림 핀 문제 더미를 처리해줍니다:

- **MeloTTS는 오래된 transformers를 핀**(4.27.4) → tokenizers 0.13.x 강제 → cp312 휠 없음 → 손상된 Rust 소스 빌드. 헬퍼는 MeloTTS를 클론하고 `transformers>=4.36.0`으로 핀 해제 (안정 API만 사용).
- **transformers는 torch ≥ 2.6 필요** ([CVE-2025-32434](https://nvd.nist.gov/vuln/detail/CVE-2025-32434)). 헬퍼는 PyTorch CPU 휠 인덱스에서 `torch==2.6.0+cpu`를 사전 설치합니다 — 그렇지 않으면 pip가 ~3 GB의 불필요한 CUDA 휠을 끌어옵니다.
- **librosa 0.9.1**은 setuptools 81+에서 제거된 `pkg_resources`를 사용합니다. 헬퍼는 `librosa>=0.10`으로 올립니다.
- **jieba/pykakasi**도 여전히 `pkg_resources`가 필요합니다. 헬퍼는 `setuptools<81`로 핀합니다.
- **unidic 일본어 사전**은 휠에서 자동 다운로드되지 않습니다. 헬퍼는 `python -m unidic download` (~250 MB)를 실행해 KR 전용 세션에서도 MeloTTS의 즉시 일본어 임포트가 충돌하지 않도록 합니다.

## 한계

- **음성 품질.** MeloTTS 한국어는 좋습니다 — 자연스러운 운율, 단일 보이스. 다중 보이스 옵션이 있는 한국어 스피커를 원한다면 다른 엔진(Coqui XTTS-v2, MOSS-TTS-Nano with reference clips)이 필요합니다. 오늘 기준 미구축.
- **부팅 시간.** 첫 한국어 발화는 MeloTTS가 PyTorch + 한국어 BERT (~500MB) 다운로드를 로드하는 데 ~17–60초 걸립니다. 봇 실행당 1회 비용.
- **대화 중 언어 전환.** 영어로 말한 다음 한국어로 말하면 봇은 턴별로 올바르게 라우팅합니다 — 추가 설정 없음. 그러나 에이전트의 히스토리는 단일 트랙이므로 "EN: hello / KO: 안녕"이 섞여 보입니다. 괜찮습니다 — LLM은 이를 자연스럽게 처리합니다.

## 다른 언어들

`TTS_ENGINE=auto`는 한국어를 특별 처리합니다 (`ko` → MeloTTS). 다른 언어는 Kokoro로 라우팅됩니다. 예를 들어 스페인어나 프랑스어를 Kokoro 대신 MeloTTS로 사용하려면:

```env
TTS_ENGINE=melotts
MELOTTS_LANG=ES   # 또는 FR, JP, ZH, EN
```

이는 봇을 하나의 MeloTTS 언어 모델로 핀합니다 — 자동 라우팅 없음, Kokoro 없음. 일반적으로 `auto`를 원할 것입니다.
