#!/usr/bin/env bash
# Download local ML models needed by Papercup. Idempotent — skips existing files.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p models

fetch() {
  local url="$1" path="$2" name="$3"
  if [[ -f "$path" ]]; then
    echo "$name already present ($(stat -c%s "$path") bytes)"
  else
    echo "Downloading $name…"
    curl -fsSL --retry 3 -o "$path" "$url"
    echo "  → $path ($(stat -c%s "$path") bytes)"
  fi
}

fetch \
  "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx" \
  "models/silero_vad.onnx" \
  "silero_vad.onnx"

fetch \
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx" \
  "models/kokoro-v1.0.onnx" \
  "kokoro-v1.0.onnx"

fetch \
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin" \
  "models/kokoro-voices-v1.0.bin" \
  "kokoro-voices-v1.0.bin"
