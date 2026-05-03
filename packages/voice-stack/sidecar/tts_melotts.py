"""
Long-running MeloTTS sidecar.

MeloTTS supports a wider language set than Kokoro — most importantly Korean,
which Kokoro v1.0 doesn't ship. PyTorch-based; heavier than the kokoro-onnx
sidecar (~700 MB venv vs ~200 MB) but still real-time on a 4-core CPU.

Same wire protocol as tts_kokoro.py:
  Node → sidecar (stdin, binary):
    8-byte header: u32 BE request id, u32 BE UTF-8 byte length
    payload: that many UTF-8 bytes of text

  Sidecar → Node (stdout, mixed binary + line-buffered text):
    16-byte header: u32 BE request id, u32 BE flags, u32 BE sample count, u32 BE sample rate
    payload: that many s16 little-endian mono samples (only if ok)
    one trailing JSON line: {"id": ..., "ok": true/false, "ms": ..., "sample_rate": ..., "lang": "...", ...}
"""
import json
import os
import struct
import sys
import time

import numpy as np

LANGUAGE = os.environ.get("MELOTTS_LANG", "KR")  # KR | EN | ES | FR | ZH | JP
DEVICE = os.environ.get("MELOTTS_DEVICE", "cpu")
SPEED = float(os.environ.get("MELOTTS_SPEED", "1.0"))
DEFAULT_SPEAKER = os.environ.get("MELOTTS_SPEAKER", "")  # blank → use language default


def log(msg: str) -> None:
    print(f"[tts:melotts] {msg}", file=sys.stderr, flush=True)


def main() -> None:
    log(f"loading language={LANGUAGE} device={DEVICE} speed={SPEED}")
    t0 = time.time()
    # Import inside main so heavy torch imports don't block on stdin probes.
    from melo.api import TTS  # type: ignore

    model = TTS(language=LANGUAGE, device=DEVICE)
    speaker_ids = model.hps.data.spk2id
    speaker_keys = list(speaker_ids.keys()) if hasattr(speaker_ids, "keys") else list(vars(speaker_ids).keys())
    sample_rate = int(model.hps.data.sampling_rate)

    speaker = DEFAULT_SPEAKER if DEFAULT_SPEAKER in speaker_keys else speaker_keys[0]
    speaker_id = int(speaker_ids[speaker])

    log(
        f"ready in {time.time() - t0:.2f}s; "
        f"sr={sample_rate} speakers={speaker_keys} default={speaker}"
    )
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
            # output_path=None → returns numpy float32 array at sample_rate
            audio_f32 = model.tts_to_file(
                text,
                speaker_id,
                output_path=None,
                speed=SPEED,
                quiet=True,
            )
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
                "speaker": speaker,
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
