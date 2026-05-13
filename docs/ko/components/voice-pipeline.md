# 음성 파이프라인 (VAD / STT / TTS)

음성 스택은 `@papercup/voice-stack`에 있습니다. Node 래퍼 + Python 사이드카 (STT용 하나, TTS 엔진별 하나) + ONNX 모델.

## VAD: Silero

**위치:** `packages/voice-stack/src/vad/silero.ts` (Node, `onnxruntime-node`를 통해 in-process)

**모델:** `silero_vad.onnx` (~2.3 MB)

**입력:** 16 kHz 모노 float32 PCM, 512-샘플 (32 ms) 윈도우.

**중요한 세부사항:** 공식 Silero ONNX는 각 윈도우 앞에 **64-샘플 롤링 컨텍스트 버퍼**가 필요합니다 — 모델은 실제로 `[1, 512]`가 아닌 `[1, 576]`을 봅니다. 이게 없으면 실제 음성을 포함한 모든 것에 대해 출력이 ~0.001입니다. 원래 "VAD가 항상 노이즈라고 함" 버그였습니다.

```ts
import { SileroVad } from "@papercup/voice-stack/vad";

const vad = new SileroVad();
await vad.load();
for (const window of windows512) {
  const probability = await vad.run(window);  // 0..1
}
vad.reset();  // LSTM 상태 + 컨텍스트 초기화
```

## STT: Whisper (faster-whisper 사이드카를 통해)

**위치:**
- Node 클라이언트: `packages/voice-stack/src/stt/whisper.ts`
- Python 사이드카: `packages/voice-stack/sidecar/stt.py`

**모델:** `WHISPER_MODEL` 환경 변수로 설정 가능. 다국어 TTS 경로(`auto`/`melotts`/`xtts`)는 `small` 기본, kokoro 전용은 `base` 기본.

**Compute:** CPU에서 `int8` (4-코어 홈랩에서 ~0.3 RTF). GPU에서는 `float16` 사용.

**와이어 프로토콜** (사양은 `stt.py` 상단 참조):
- Node→사이드카: 8바이트 헤더 (req id, 샘플 수) + float32 LE PCM
- 사이드카→Node: 요청당 한 JSON 줄: `{id, text, lang, duration, elapsed, rtf}`

사이드카는 봇의 수명 동안 하나의 Python 서브프로세스입니다. 재시작은 캐시된 가중치에 대해 ~1초의 모델 로드 비용.

```ts
import { WhisperSidecar } from "@papercup/voice-stack/stt";

const stt = new WhisperSidecar();
await stt.start();
const { text, rtf } = await stt.transcribe(mono16kFloat32);
```

## TTS: 3개 엔진 + 자동 라우터

**위치:**
- 플러그형 인터페이스: `packages/voice-stack/src/tts/index.ts`
- 엔진별 래퍼: `kokoro.ts`, `melotts.ts`, `xtts.ts`, `auto.ts`
- Python 사이드카: `sidecar/tts_kokoro.py`, `tts_melotts.py`, `tts_xtts.py`

`TTS_ENGINE=auto` (기본)는 Whisper가 감지한 언어를 기반으로 발화별 라우팅:

| 감지된 언어 | 엔진 | 이유 |
| --- | --- | --- |
| `ko` | MeloTTS 또는 XTTS-v2 (`TTS_KO_ENGINE`로 선택) | Kokoro에 한국어 없음 |
| 그 외 | Kokoro | 가볍고 CPU에서 실시간 |

### Kokoro

**모델:** `kokoro-v1.0.onnx` (~325 MB) + `kokoro-voices-v1.0.bin` (~28 MB)

**네이티브 샘플 레이트:** 24 kHz 모노. Discord용으로 `mono24kS16ToStereo48kS16`을 통해 48 kHz 스테레오로 업샘플링.

**보이스:** 기본 54개 로드. 미국식 영어(`af_*`, `am_*`), 영국식(`bf_*`, `bm_*`), 일본어(`jf_*`, `jm_*`), 중국어 보통화(`zf_*`, `zm_*`), 등.

**언어:** en/ja/zh/es/fr/hi/it/pt. **한국어 없음.**

### MeloTTS (한국어 — 경량)

**모델:** ~200 MB (한국어 보이스 + g2p) + ~440 MB (첫 사용 시 캐시되는 한국어 BERT).

**네이티브 샘플 레이트:** 44.1 kHz 모노.

**스피커:** 언어당 1명 (한국어 음성 다양성 없음 — 단일 모노톤 스피커).

**Pre-warm:** 캐시된 가중치에 대해 ~17초 로드. `MELOTTS_PREWARM=0`은 첫 KR 호출로 연기.

### XTTS-v2 (한국어 — 더 무거움, 보이스 클로닝)

**모델:** Coqui XTTS-v2 ~1.8 GB; 스피커 임베딩 파일 ~7 MB.

**네이티브 샘플 레이트:** 24 kHz 모노.

**스피커:** ~58개 내장 (Daisy Studious, Claribel Dervla, Gracie Wise, Damien Black, Andrew Chipper, …) + `XTTS_REFERENCE_WAV`를 통한 보이스 클로닝.

**Pre-warm:** 캐시된 가중치에 대해 ~30초 로드. `XTTS_PREWARM=0`은 연기.

### 와이어 프로토콜 (모든 사이드카가 공유)

이진 + 라인 버퍼링 텍스트 혼합:
- Node→사이드카: 8바이트 헤더 (req id, 텍스트 바이트 길이) + UTF-8 텍스트
- 사이드카→Node: 16바이트 헤더 (id, ok flag, 샘플 수, 샘플 레이트) + s16 LE PCM, 그리고 JSON 라인

```ts
import { createTts } from "@papercup/voice-stack/tts";

const tts = createTts(process.env.TTS_ENGINE ?? "auto");
await tts.start();
const { pcm, sampleRate, durationMs } = await tts.synthesize("hello world", { lang: "en" });
```

## 오디오 배관

`packages/voice-stack/src/audio/`:

- `resample.ts` — 48 kHz s16 스테레오 (Discord 출력) → 16 kHz 모노 float32 (Silero/Whisper 입력). L+R 평균으로 3분의 1로 데시메이트. 안티-앨리어스 필터 없음.
- `upsample.ts` — 24 kHz s16 모노 (Kokoro 출력) → 48 kHz s16 스테레오 (Discord 입력). 선형 보간 2× + 두 채널로 복제.

둘 다 순수 함수, 의존성 없음, 격리해서 테스트하기 쉬움.

## 새로운 TTS 엔진 추가

Kokoro 구현 미러링. 세 부분:

1. `packages/voice-stack/sidecar/tts_<name>.py`에 동일한 stdio 프레이밍을 가진 새 Python 사이드카
2. `TtsEngine`을 구현하는 Node 래퍼 클래스 (`start()`, `synthesize()`, `stop()`)
3. `packages/voice-stack/src/tts/index.ts`의 `createTts()`에 등록

그러면 `.env`의 `TTS_ENGINE=<name>`이 선택합니다.
