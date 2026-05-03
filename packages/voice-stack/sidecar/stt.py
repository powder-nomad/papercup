"""
Long-running Whisper STT sidecar.

Protocol over stdio:
  Node → sidecar (stdin, binary):
    8-byte header: u32 BE request id, u32 BE float32 sample count
    payload: that many float32 LE samples (mono, 16 kHz)

  Sidecar → Node (stdout, line-buffered text):
    one JSON line per request:
      {"id": 17, "text": "...", "lang": "en", "duration": 1.52, "elapsed": 0.43, "rtf": 0.28}

  Logs go to stderr.
"""
import json
import os
import struct
import sys
import time

import numpy as np
from faster_whisper import WhisperModel

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base.en")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
BEAM = int(os.environ.get("WHISPER_BEAM", "1"))


def log(msg: str) -> None:
    print(f"[stt] {msg}", file=sys.stderr, flush=True)


def main() -> None:
    log(f"loading model={MODEL_SIZE} device={DEVICE} compute={COMPUTE}")
    t0 = time.time()
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE)
    log(f"ready in {time.time() - t0:.2f}s")
    sys.stdout.write("READY\n")
    sys.stdout.flush()

    stdin = sys.stdin.buffer

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
        req_id, n_samples = struct.unpack(">II", header)
        pcm_bytes = read_exact(n_samples * 4)
        if pcm_bytes is None:
            log("truncated payload; exiting")
            return
        audio = np.frombuffer(pcm_bytes, dtype="<f4")  # little-endian float32

        duration = len(audio) / 16000.0
        t0 = time.time()
        try:
            segments, info = model.transcribe(
                audio,
                beam_size=BEAM,
                vad_filter=False,  # Silero VAD already gated this upstream
                language="en" if MODEL_SIZE.endswith(".en") else None,
                condition_on_previous_text=False,
            )
            text = " ".join(s.text.strip() for s in segments).strip()
            lang = info.language
        except Exception as e:
            log(f"transcribe failed for req {req_id}: {e}")
            text = ""
            lang = None
        elapsed = time.time() - t0

        out = {
            "id": req_id,
            "text": text,
            "lang": lang,
            "duration": round(duration, 3),
            "elapsed": round(elapsed, 3),
            "rtf": round(elapsed / max(duration, 0.001), 3),
        }
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
