#!/usr/bin/env bash
# Papercup universal installer.
#
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/powder-nomad/papercup/main/install.sh) [flags]
#
# Flags (all optional — anything you skip falls back to a sensible default and
# can be edited later in packages/bot/.env):
#
#   --dir <path>              Install location. Default: $HOME/papercup
#   --branch <name>           Git branch to clone. Default: main
#   --discord-token <token>   Bot token from the Discord developer portal
#   --discord-client-id <id>  Application ID from the Discord developer portal
#   --discord-guild-id <id>   Server (guild) ID from the Discord client
#
#   --agent <name>            Speaker agent backend. claude-code (default) |
#                             codex | anthropic-api
#   --model <name>            Agent model. Default: haiku
#   --anthropic-api-key <k>   Required only if --agent=anthropic-api
#
#   --vad <name>              VAD engine. silero (default; only option today)
#   --stt <name>              STT engine. whisper-base.en (default) |
#                             whisper-base | whisper-small.en | whisper-small
#   --tts <name>              TTS engine.
#                               kokoro  — en/ja/zh/es/fr/hi/it/pt (no Korean)
#                               melotts — Korean and others (heavier, +PyTorch)
#                               auto    — Kokoro for non-Korean, MeloTTS for Korean (recommended)
#   --voice <name>            Kokoro voice. Default: af_heart
#
#   --silence-ms <int>        End-of-utterance silence (ms). Default: 600
#   --vad-threshold <float>   Speech probability threshold. Default: 0.4
#
#   --skip-models             Don't download voice models (you'll have to run
#                             scripts/download-models.sh later)
#   --skip-venv               Don't create the Python venv
#   --skip-register           Don't push slash commands to Discord
#   --no-start                Install only; don't start the daemon at the end
#   --yes                     Accept all defaults; never prompt
#
#   -h | --help               Show this help and exit

set -euo pipefail

# ───────────────────────────────────────────────────────────────────────────
# Defaults
# ───────────────────────────────────────────────────────────────────────────
INSTALL_DIR="${HOME}/papercup"
BRANCH="main"
REPO_URL="https://github.com/powder-nomad/papercup.git"

DISCORD_TOKEN=""
DISCORD_CLIENT_ID=""
DISCORD_GUILD_ID=""

AGENT_BACKEND="claude-code"
AGENT_MODEL="haiku"
ANTHROPIC_API_KEY=""

VAD_ENGINE="silero"
STT_ENGINE=""   # auto-defaults below: whisper-small for multilingual TTS, whisper-base for Kokoro-only
TTS_ENGINE="auto"
KOKORO_VOICE="af_heart"

SILENCE_MS="600"
VAD_THRESHOLD="0.4"
VAD_MIN_SPEECH_WINDOWS="3"

DO_MODELS=1
DO_VENV=1
DO_REGISTER=1
DO_START=1
ASSUME_YES=0

# ───────────────────────────────────────────────────────────────────────────
# Pretty output
# ───────────────────────────────────────────────────────────────────────────
c_dim='\033[2m'
c_red='\033[0;31m'
c_grn='\033[0;32m'
c_yel='\033[0;33m'
c_blu='\033[0;34m'
c_rst='\033[0m'

step() { printf "${c_blu}==>${c_rst} %s\n" "$*"; }
ok()   { printf "${c_grn} ✓${c_rst} %s\n" "$*"; }
warn() { printf "${c_yel} ⚠${c_rst} %s\n" "$*" >&2; }
die()  { printf "${c_red} ✗${c_rst} %s\n" "$*" >&2; exit 1; }
ask()  {
  local prompt="$1" default="${2:-}" var
  if [[ "$ASSUME_YES" == "1" ]]; then printf "%s" "$default"; return; fi
  if [[ -n "$default" ]]; then
    read -r -p "$prompt [$default]: " var </dev/tty
  else
    read -r -p "$prompt: " var </dev/tty
  fi
  printf "%s" "${var:-$default}"
}

usage() {
  sed -n '2,/^set -euo pipefail$/p' "$0" | sed 's/^# \?//;s/^#$//' | head -n -1
  exit 0
}

# ───────────────────────────────────────────────────────────────────────────
# Parse flags
# ───────────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2;;
    --branch) BRANCH="$2"; shift 2;;
    --discord-token) DISCORD_TOKEN="$2"; shift 2;;
    --discord-client-id) DISCORD_CLIENT_ID="$2"; shift 2;;
    --discord-guild-id) DISCORD_GUILD_ID="$2"; shift 2;;
    --agent) AGENT_BACKEND="$2"; shift 2;;
    --model) AGENT_MODEL="$2"; shift 2;;
    --anthropic-api-key) ANTHROPIC_API_KEY="$2"; shift 2;;
    --vad) VAD_ENGINE="$2"; shift 2;;
    --stt) STT_ENGINE="$2"; shift 2;;
    --tts) TTS_ENGINE="$2"; shift 2;;
    --voice) KOKORO_VOICE="$2"; shift 2;;
    --silence-ms) SILENCE_MS="$2"; shift 2;;
    --vad-threshold) VAD_THRESHOLD="$2"; shift 2;;
    --skip-models) DO_MODELS=0; shift;;
    --skip-venv) DO_VENV=0; shift;;
    --skip-register) DO_REGISTER=0; shift;;
    --no-start) DO_START=0; shift;;
    --yes|-y) ASSUME_YES=1; shift;;
    -h|--help) usage;;
    *) die "Unknown flag: $1 (try --help)";;
  esac
done

# ───────────────────────────────────────────────────────────────────────────
# Sanity: dependencies
# ───────────────────────────────────────────────────────────────────────────
step "Checking system dependencies"
have() { command -v "$1" >/dev/null 2>&1; }
have git    || die "git not installed"
have node   || die "node not installed (need Node 20+)"
have npm    || die "npm not installed"
have python3 || die "python3 not installed (need 3.10+)"

# Node version >= 20
node_major=$(node --version | sed 's/v//;s/\..*//')
[[ "$node_major" -ge 20 ]] || die "Node 20+ required (got $(node --version))"
ok "node $(node --version), npm $(npm --version), python3 $(python3 --version | awk '{print $2}')"

# Optional but warned if missing
have espeak-ng || warn "espeak-ng not found — Kokoro TTS will fail. Install: apt-get install espeak-ng (Linux) | brew install espeak-ng (mac)"
# MeloTTS (Korean / multilingual) needs MeCab system libs + a few build deps.
case "$TTS_ENGINE" in
  melotts|auto)
    missing_pkgs=()
    for pkg in libmecab-dev mecab-ipadic-utf8 libssl-dev pkg-config; do
      if ! dpkg -s "$pkg" >/dev/null 2>&1; then
        missing_pkgs+=("$pkg")
      fi
    done
    if (( ${#missing_pkgs[@]} > 0 )); then
      warn "MeloTTS apt deps missing: ${missing_pkgs[*]} — install: apt-get install ${missing_pkgs[*]} (Linux) | brew install mecab mecab-ipadic openssl pkg-config (mac)"
    fi
    ;;
esac

case "$AGENT_BACKEND" in
  claude-code) have claude || warn "AGENT_BACKEND=claude-code but 'claude' CLI not on PATH. Speaker won't respond until you install Claude Code.";;
  codex)       have codex || warn "AGENT_BACKEND=codex but 'codex' CLI not on PATH.";;
  anthropic-api) [[ -n "$ANTHROPIC_API_KEY" ]] || warn "AGENT_BACKEND=anthropic-api but no --anthropic-api-key provided. Speaker won't respond until you set ANTHROPIC_API_KEY in .env.";;
  *) die "Unknown --agent value: $AGENT_BACKEND (expected claude-code, codex, anthropic-api)";;
esac

# ───────────────────────────────────────────────────────────────────────────
# Clone (or update) the repo
# ───────────────────────────────────────────────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  step "Updating existing install at $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
  ok "git updated"
else
  step "Cloning $REPO_URL → $INSTALL_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  ok "cloned"
fi

cd "$INSTALL_DIR"

# ───────────────────────────────────────────────────────────────────────────
# Discord credentials
# ───────────────────────────────────────────────────────────────────────────
ENV_FILE="packages/bot/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cp packages/bot/.env.example "$ENV_FILE"
fi

# Read existing values from env file if not provided as flags
read_env() {
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | sed "s/^$1=//"
}
[[ -z "$DISCORD_TOKEN" ]]     && DISCORD_TOKEN=$(read_env DISCORD_TOKEN)
[[ -z "$DISCORD_CLIENT_ID" ]] && DISCORD_CLIENT_ID=$(read_env DISCORD_CLIENT_ID)
[[ -z "$DISCORD_GUILD_ID" ]]  && DISCORD_GUILD_ID=$(read_env DISCORD_GUILD_ID)

if [[ -z "$DISCORD_TOKEN" || -z "$DISCORD_CLIENT_ID" || -z "$DISCORD_GUILD_ID" ]]; then
  step "Discord credentials needed"
  echo "  Bot token: dev portal → your app → Bot tab → Reset Token"
  echo "  Client ID: dev portal → General Information"
  echo "  Guild ID:  Discord client (Developer Mode on) → right-click server → Copy ID"
  echo
  [[ -z "$DISCORD_TOKEN" ]]     && DISCORD_TOKEN=$(ask "DISCORD_TOKEN")
  [[ -z "$DISCORD_CLIENT_ID" ]] && DISCORD_CLIENT_ID=$(ask "DISCORD_CLIENT_ID")
  [[ -z "$DISCORD_GUILD_ID" ]]  && DISCORD_GUILD_ID=$(ask "DISCORD_GUILD_ID")
fi

# ───────────────────────────────────────────────────────────────────────────
# Write .env (replace each line in place)
# ───────────────────────────────────────────────────────────────────────────
step "Writing $ENV_FILE"
write_env() {
  local key="$1" val="$2" file="$ENV_FILE"
  if grep -qE "^${key}=" "$file"; then
    # Use python so we don't fight sed escaping for tokens
    python3 - <<PY
import sys, re, pathlib
p = pathlib.Path("$file")
lines = p.read_text().splitlines(keepends=True)
out = []
seen = False
for line in lines:
    if re.match(r"^${key}=", line):
        out.append(f"${key}=${val}\n"); seen = True
    else:
        out.append(line)
if not seen:
    out.append(f"${key}=${val}\n")
p.write_text("".join(out))
PY
  else
    printf "%s=%s\n" "$key" "$val" >> "$file"
  fi
}

# Default STT depends on whether the user wants multilingual TTS:
# - auto/melotts → whisper-small (better Korean / non-English accuracy, ~244MB)
# - kokoro       → whisper-base  (English-leaning, lighter, ~140MB)
if [[ -z "$STT_ENGINE" ]]; then
  case "$TTS_ENGINE" in
    auto|melotts) STT_ENGINE="whisper-small" ;;
    *)            STT_ENGINE="whisper-base"  ;;
  esac
fi

# Map UI-friendly STT/TTS names to actual env vars
case "$STT_ENGINE" in
  whisper-base.en)   WHISPER_MODEL="base.en";;
  whisper-base)      WHISPER_MODEL="base";;
  whisper-small.en)  WHISPER_MODEL="small.en";;
  whisper-small)     WHISPER_MODEL="small";;
  *)                 WHISPER_MODEL="${STT_ENGINE#whisper-}";;
esac

write_env DISCORD_TOKEN "$DISCORD_TOKEN"
write_env DISCORD_CLIENT_ID "$DISCORD_CLIENT_ID"
write_env DISCORD_GUILD_ID "$DISCORD_GUILD_ID"
write_env SILENCE_MS "$SILENCE_MS"
write_env VAD_THRESHOLD "$VAD_THRESHOLD"
write_env VAD_MIN_SPEECH_WINDOWS "$VAD_MIN_SPEECH_WINDOWS"
write_env WHISPER_MODEL "$WHISPER_MODEL"
write_env TTS_ENGINE "$TTS_ENGINE"
write_env KOKORO_VOICE "$KOKORO_VOICE"
write_env AGENT_BACKEND "$AGENT_BACKEND"
write_env AGENT_MODEL "$AGENT_MODEL"
[[ -n "$ANTHROPIC_API_KEY" ]] && write_env ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
ok ".env written"

# ───────────────────────────────────────────────────────────────────────────
# Node deps
# ───────────────────────────────────────────────────────────────────────────
step "Installing Node deps (npm install — may take a minute on cold cache)"
npm install --silent 2>&1 | tail -3 || die "npm install failed"
ok "node_modules ready"

# ───────────────────────────────────────────────────────────────────────────
# Python venv
# ───────────────────────────────────────────────────────────────────────────
if [[ "$DO_VENV" == "1" ]]; then
  VENV_DIR="packages/voice-stack/sidecar/.venv"
  if [[ ! -x "$VENV_DIR/bin/python" ]]; then
    step "Creating Python venv at $VENV_DIR (this is the slow step — ~700MB of wheels)"
    python3 -m venv "$VENV_DIR"
    "$VENV_DIR/bin/pip" install --upgrade --quiet pip
    "$VENV_DIR/bin/pip" install --quiet -r packages/voice-stack/sidecar/requirements.txt
    ok "venv installed"
  else
    ok "venv already exists at $VENV_DIR"
  fi

  # MeloTTS install path: separate script that handles upstream pin issues +
  # CPU-only torch + post-install dance. Run when TTS_ENGINE wants Korean.
  case "$TTS_ENGINE" in
    melotts|auto)
      if "$VENV_DIR/bin/python" -c "import melo.api" >/dev/null 2>&1; then
        ok "melotts already installed"
      else
        step "Installing MeloTTS (Korean TTS) — adds ~1.3GB to venv (torch + BERT)"
        bash packages/voice-stack/sidecar/install-melotts.sh "$VENV_DIR" \
          || die "MeloTTS install failed — check apt prereqs (libmecab-dev, libssl-dev, pkg-config) and re-run"
        ok "melotts installed"
      fi
      ;;
  esac
fi

# ───────────────────────────────────────────────────────────────────────────
# Models
# ───────────────────────────────────────────────────────────────────────────
if [[ "$DO_MODELS" == "1" ]]; then
  step "Downloading voice models (~355MB total)"
  bash packages/voice-stack/scripts/download-models.sh
  ok "models ready"
fi

# ───────────────────────────────────────────────────────────────────────────
# Register slash commands with Discord
# ───────────────────────────────────────────────────────────────────────────
if [[ "$DO_REGISTER" == "1" ]]; then
  step "Registering slash commands"
  npm run register --workspace=@papercup/bot --silent 2>&1 | tail -3
  ok "slash commands pushed to Discord"
fi

# ───────────────────────────────────────────────────────────────────────────
# Capability summary
# ───────────────────────────────────────────────────────────────────────────
echo
printf "${c_grn}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c_rst}\n"
printf "${c_grn} Papercup install complete${c_rst}\n"
printf "${c_grn}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c_rst}\n"
echo
printf "  ${c_dim}Install dir${c_rst}     %s\n" "$INSTALL_DIR"
printf "  ${c_dim}VAD${c_rst}             %s\n" "$VAD_ENGINE"
printf "  ${c_dim}STT${c_rst}             %s (${WHISPER_MODEL}, English-only? %s)\n" "$STT_ENGINE" "$([[ "$WHISPER_MODEL" == *.en ]] && echo yes || echo no)"
printf "  ${c_dim}TTS${c_rst}             %s (voice: %s)\n" "$TTS_ENGINE" "$KOKORO_VOICE"
printf "  ${c_dim}Agent backend${c_rst}   %s (model: %s)\n" "$AGENT_BACKEND" "$AGENT_MODEL"
echo
echo "Capabilities matrix:"
case "$WHISPER_MODEL" in
  *.en) printf "  STT: ${c_yel}English only${c_rst}\n";;
  *)    printf "  STT: ${c_grn}multilingual${c_rst} (Whisper auto-detects 99 langs incl. Korean)\n";;
esac
case "$TTS_ENGINE" in
  kokoro)  printf "  TTS: ${c_yel}en/ja/zh/es/fr/hi/it/pt only${c_rst} (Kokoro — no Korean)\n";;
  melotts) printf "  TTS: ${c_grn}Korean${c_rst} (MeloTTS pinned to KR; en/ja/zh/es/fr also available via MELOTTS_LANG)\n";;
  auto)    printf "  TTS: ${c_grn}all common languages${c_rst} (Kokoro for en/ja/zh/es/fr/hi/it/pt, MeloTTS for ko)\n";;
esac
echo

# ───────────────────────────────────────────────────────────────────────────
# Start daemon
# ───────────────────────────────────────────────────────────────────────────
if [[ "$DO_START" == "1" ]]; then
  step "Starting bot"
  bash packages/bot/bin/papercup start
  echo
  echo "Tail logs:   bash $INSTALL_DIR/packages/bot/bin/papercup logs"
  echo "Stop bot:    bash $INSTALL_DIR/packages/bot/bin/papercup stop"
  echo "Status:      bash $INSTALL_DIR/packages/bot/bin/papercup status"
else
  echo "Skipped daemon start (--no-start). Launch with:"
  echo "  bash $INSTALL_DIR/packages/bot/bin/papercup start"
fi

echo
ok "Done."
