#!/usr/bin/env bash
# Papercup one-shot setup. Run from the repo root:
#   bash setup.sh
#
# Everything except creating the Discord app is automated. You'll be prompted
# for the bot token, client ID, and guild ID — paste them in when asked.
set -euo pipefail

cd "$(dirname "$0")"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }

# ---------- 1. toolchain ----------
bold "→ Checking toolchain…"
if ! command -v node >/dev/null; then
  red "node not found. Install Node 20+ and re-run."; exit 1
fi
node_major=$(node -p 'process.versions.node.split(".")[0]')
if [[ "$node_major" -lt 20 ]]; then
  red "Node $node_major detected; need 20+."; exit 1
fi
if ! command -v gcc >/dev/null || ! command -v python3 >/dev/null; then
  yellow "gcc or python3 missing — native modules may fail. On Ubuntu:"
  yellow "  sudo apt install -y build-essential python3"
fi
green "  toolchain OK ($(node --version), npm $(npm --version))"

# ---------- 2. deps ----------
if [[ ! -d node_modules ]]; then
  bold "→ Installing dependencies…"
  npm install --silent
  green "  deps installed"
else
  dim "  deps already installed (delete node_modules to reinstall)"
fi

# ---------- 3. .env ----------
bold "→ Configuring .env…"
if [[ ! -f .env ]]; then
  cp .env.example .env
  dim "  created .env from .env.example"
fi

prompt_var() {
  local key="$1" label="$2" current
  current=$(grep -E "^${key}=" .env | head -n1 | cut -d= -f2- || true)
  if [[ -n "$current" ]]; then
    dim "  $key already set (skipping)"
    return
  fi
  printf '  %s: ' "$label"
  read -r value
  if [[ -z "$value" ]]; then
    red "  $key is required."; exit 1
  fi
  # Escape any & or | in the value for sed.
  local escaped
  escaped=$(printf '%s\n' "$value" | sed -e 's/[\/&|]/\\&/g')
  sed -i "s|^${key}=.*|${key}=${escaped}|" .env
  green "  $key saved"
}

bold "  Paste values from the Discord developer portal."
bold "  (Skip any field by leaving it blank only if it's already in .env.)"
echo
prompt_var DISCORD_TOKEN "Bot token (Bot tab → Reset Token)"
prompt_var DISCORD_CLIENT_ID "Application ID (General Information tab)"
prompt_var DISCORD_GUILD_ID "Server ID (right-click your server → Copy Server ID)"

# Re-source .env to use the values we just wrote.
set -a; source .env; set +a

# ---------- 4. invite URL ----------
bold "→ Invite URL"
# Permissions: Connect (1<<20) + Speak (1<<21) + Use Voice Activity (1<<25)
#            + Send Messages (1<<11) + View Channel (1<<10) = 36703232
PERMS=36703232
INVITE_URL="https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&permissions=${PERMS}&scope=bot%20applications.commands"
echo "  Open this URL and add the bot to your server:"
echo
green "    $INVITE_URL"
echo
read -r -p "  Press Enter once the bot is in your server…" _

# ---------- 5. register slash commands ----------
bold "→ Registering /pickup and /hangup…"
npm run --silent register
green "  commands registered"

# ---------- 6. launch ----------
bold "→ Starting the cup. Press Ctrl+C to hang up the process."
echo
echo "  Next steps inside Discord:"
echo "    1. Join a voice channel"
echo "    2. Run /pickup"
echo "    3. Talk, then pause for ~2 seconds"
echo "    4. The bot replays your audio"
echo "    5. /hangup when done"
echo
exec npm run --silent start
