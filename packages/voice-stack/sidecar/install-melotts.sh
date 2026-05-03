#!/usr/bin/env bash
# Install MeloTTS into an existing sidecar venv.
#
# MeloTTS upstream pins transformers==4.27.4, which pulls tokenizers 0.13.x —
# no cp312 prebuilt wheel exists, so pip falls back to a source build that
# fails on modern Rust due to upstream code rot. We side-step the whole mess
# by cloning MeloTTS, unpinning transformers, and installing locally. MeloTTS
# only uses AutoTokenizer + AutoModelForMaskedLM, both stable since 4.x.
#
# Other workarounds wired in here:
#   - Pre-install torch CPU-only from pytorch.org so pip doesn't pull ~3 GB of
#     CUDA wheels we never use on a CPU homelab.
#   - torch >= 2.6 because newer transformers refuse older versions
#     (CVE-2025-32434).
#   - Pin setuptools < 81 so legacy deps (jieba, pykakasi, librosa<0.10) keep
#     finding pkg_resources.
#   - Bump librosa to >= 0.10 (drops pkg_resources requirement at runtime).
#   - Run `python -m unidic download` so MeloTTS's eager Japanese tokenizer
#     import doesn't trip on the missing dictionary even for KR-only sessions.
set -euo pipefail

VENV="${1:?usage: install-melotts.sh <venv-dir>}"
PY="$VENV/bin/python"
PIP="$PY -m pip install --no-cache-dir"

[[ -x "$PY" ]] || { echo "no python at $PY"; exit 1; }

echo "[melotts] installing torch 2.6 CPU-only (avoids 3 GB CUDA wheels)"
$PIP --index-url https://download.pytorch.org/whl/cpu \
  "torch==2.6.0+cpu" "torchaudio==2.6.0+cpu" >/dev/null

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "[melotts] cloning + patching MeloTTS in $TMP"
git clone --depth 1 https://github.com/myshell-ai/MeloTTS.git "$TMP/MeloTTS" >/dev/null 2>&1
# unpin transformers — MeloTTS only uses stable AutoTokenizer / AutoModelForMaskedLM
sed -i 's/^transformers==.*/transformers>=4.36.0/' "$TMP/MeloTTS/requirements.txt"

echo "[melotts] installing MeloTTS (compiles a few small wheels)"
$PIP "$TMP/MeloTTS" >/dev/null

echo "[melotts] post-install: pin setuptools<81 (pkg_resources for jieba etc), bump librosa"
$PIP "setuptools<81" "librosa>=0.10" >/dev/null

echo "[melotts] downloading unidic Japanese dict (MeloTTS imports it eagerly)"
$PY -m unidic download >/dev/null 2>&1 || true

echo "[melotts] verifying import"
$PY -c "from melo.api import TTS; print('[melotts] import ok')"
