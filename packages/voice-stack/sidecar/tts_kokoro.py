"""
Long-running Kokoro TTS sidecar.

Protocol over stdio:
  Node → sidecar (stdin, binary):
    8-byte header: u32 BE request id, u32 BE UTF-8 byte length
    payload: that many UTF-8 bytes of text

  Sidecar → Node (stdout, mixed binary + line-buffered text):
    16-byte header: u32 BE request id, u32 BE flags, u32 BE sample count, u32 BE sample rate
      flags bit 0: 1 = ok, 0 = error
    payload: that many s16 little-endian mono samples (only if ok)
    one trailing JSON line: {"id": ..., "ok": true/false, "ms": ..., "sample_rate": ..., "voice": "...", "elapsed": ..., "rtf": ...}

  stderr: log lines.
"""
import json
import os
import struct
import sys
import time

import numpy as np
from kokoro_onnx import Kokoro

# Resolve model paths relative to the voice-stack package root so the sidecar
# works regardless of caller cwd. Override with KOKORO_MODEL / KOKORO_VOICES.
_PACKAGE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MODEL = os.environ.get("KOKORO_MODEL") or os.path.join(_PACKAGE_ROOT, "models", "kokoro-v1.0.onnx")
VOICES = os.environ.get("KOKORO_VOICES") or os.path.join(_PACKAGE_ROOT, "models", "kokoro-voices-v1.0.bin")
DEFAULT_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
DEFAULT_SPEED = float(os.environ.get("KOKORO_SPEED", "1.0"))
DEFAULT_LANG = os.environ.get("KOKORO_LANG", "en-us")


def log(msg: str) -> None:
    print(f"[tts] {msg}", file=sys.stderr, flush=True)


def main() -> None:
    log(f"loading model={MODEL} voices={VOICES} default_voice={DEFAULT_VOICE}")
    t0 = time.time()
    kokoro = Kokoro(MODEL, VOICES)
    log(f"ready in {time.time() - t0:.2f}s; voices={len(kokoro.voices)} loaded")
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
            audio_f32, sr = kokoro.create(
                text,
                voice=DEFAULT_VOICE,
                speed=DEFAULT_SPEED,
                lang=DEFAULT_LANG,
            )
            audio_i16 = np.clip(audio_f32 * 32767.0, -32768, 32767).astype("<i2")
            elapsed = time.time() - t0
            duration = len(audio_i16) / sr

            stdout.write(struct.pack(">IIII", req_id, 1, len(audio_i16), sr))
            stdout.write(audio_i16.tobytes())
            stdout.flush()

            sys.stdout.write(json.dumps({
                "id": req_id,
                "ok": True,
                "voice": DEFAULT_VOICE,
                "sample_rate": sr,
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
