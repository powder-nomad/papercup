"""
Long-running XTTS-v2 sidecar.

Coqui's XTTS-v2 is a multilingual TTS that clones any voice from a 6-second
reference clip. We use it as the Korean engine because:
  - MeloTTS Korean has only one voice and sounds monotone
  - Style-Bert-VITS2 doesn't support Korean (verified in source)
  - XTTS-v2 supports Korean and lets us pick voice via reference WAV

Same wire protocol as tts_kokoro.py / tts_melotts.py:
  Node → sidecar (stdin, binary):
    8-byte header: u32 BE request id, u32 BE UTF-8 byte length
    payload: that many UTF-8 bytes of text

  Sidecar → Node (stdout, mixed binary + line-buffered text):
    16-byte header: u32 BE request id, u32 BE flags, u32 BE sample count, u32 BE sample rate
    payload: that many s16 little-endian mono samples (only if ok)
    one trailing JSON line: {"id": ..., "ok": ..., "ms": ..., "lang": ..., ...}

Boot cost: ~30-60s on first run (downloads ~1.8GB model). Subsequent boots
load from cache in ~10-15s.
"""
import json
import os
import struct
import sys
import time

import numpy as np

LANGUAGE = os.environ.get("XTTS_LANG", "ko")  # ko | en | ja | zh-cn | es | fr | de | it | pt | pl | tr | ru | nl | cs | ar | hu
DEVICE = os.environ.get("XTTS_DEVICE", "cpu")
SPEED = float(os.environ.get("XTTS_SPEED", "1.0"))
MODEL_NAME = os.environ.get("XTTS_MODEL", "tts_models/multilingual/multi-dataset/xtts_v2")
# Voice selection — two modes, reference WAV wins if both set.
# - XTTS_REFERENCE_WAV: clone any voice from a 6s+ clip
# - XTTS_SPEAKER: use one of the built-in speakers (Claribel Dervla, Daisy Studious, Gracie Wise, …)
REFERENCE_WAV = os.environ.get("XTTS_REFERENCE_WAV", "")
DEFAULT_SPEAKER = os.environ.get("XTTS_SPEAKER", "Daisy Studious")


def log(msg: str) -> None:
    print(f"[tts:xtts] {msg}", file=sys.stderr, flush=True)


def main() -> None:
    voice_mode = "reference WAV" if REFERENCE_WAV else f"built-in speaker '{DEFAULT_SPEAKER}'"
    log(f"loading model={MODEL_NAME} lang={LANGUAGE} device={DEVICE} voice={voice_mode}")
    if REFERENCE_WAV and not os.path.isfile(REFERENCE_WAV):
        log(f"reference clip not found at {REFERENCE_WAV}; sidecar will not start")
        sys.exit(2)

    t0 = time.time()
    # Coqui expects an interactive license prompt by default; opt out.
    os.environ.setdefault("COQUI_TOS_AGREED", "1")
    from TTS.api import TTS  # type: ignore

    tts = TTS(MODEL_NAME, progress_bar=False).to(DEVICE)
    sample_rate = int(tts.synthesizer.output_sample_rate)

    log(f"ready in {time.time() - t0:.2f}s; sr={sample_rate}")
    sys.stdout.write("READY\n")
    sys.stdout.flush()

    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer

    def read_exact(n: int) -> bytes | None:
        buf = bytearray()
        while len(buf) < n:
            chunk = stdin.read(n - len(buf))
            if not chunk:
                return None
            buf.extend(chunk)
        return bytes(buf)

    while True:
        header = read_exact(8)
        if header is None:
            log("stdin closed; exiting")
            return
        req_id, n_bytes = struct.unpack(">II", header)
        text_bytes = read_exact(n_bytes)
        if text_bytes is None:
            log("truncated payload; exiting")
            return
        text = text_bytes.decode("utf-8", errors="replace")

        t0 = time.time()
        try:
            # XTTS-v2 returns float32 numpy at output_sample_rate
            tts_kwargs: dict = {"text": text, "language": LANGUAGE, "speed": SPEED}
            if REFERENCE_WAV:
                tts_kwargs["speaker_wav"] = REFERENCE_WAV
            else:
                tts_kwargs["speaker"] = DEFAULT_SPEAKER
            audio_f32 = tts.tts(**tts_kwargs)
            audio_f32 = np.asarray(audio_f32, dtype="float32")
            audio_i16 = np.clip(audio_f32 * 32767.0, -32768, 32767).astype("<i2")
            elapsed = time.time() - t0
            duration = len(audio_i16) / sample_rate

            stdout.write(struct.pack(">IIII", req_id, 1, len(audio_i16), sample_rate))
            stdout.write(audio_i16.tobytes())
            stdout.flush()

            sys.stdout.write(json.dumps({
                "id": req_id,
                "ok": True,
                "lang": LANGUAGE,
                "sample_rate": sample_rate,
                "duration": round(duration, 3),
                "elapsed": round(elapsed, 3),
                "rtf": round(elapsed / max(duration, 0.001), 3),
            }) + "\n")
            sys.stdout.flush()
        except Exception as e:
            log(f"synth failed for req {req_id}: {e}")
            stdout.write(struct.pack(">IIII", req_id, 0, 0, 0))
            stdout.flush()
            sys.stdout.write(json.dumps({"id": req_id, "ok": False, "error": str(e)}) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
