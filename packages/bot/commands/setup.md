---
description: Set up Papercup — Discord credentials, Node deps, Python sidecar, local voice models. Idempotent — safe to re-run.
---

# Papercup Setup

Walk the user through one-time installation. Everything is idempotent — if a step is already done, skip it. Always tell the user what you're about to do before doing it.

## Steps

The plugin lives at `${CLAUDE_PLUGIN_ROOT}`. All bot operations run from there.

**1. Discord credentials.**

Check `${CLAUDE_PLUGIN_ROOT}/.env`. If it doesn't exist, copy `.env.example` to `.env`. If `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, or `DISCORD_GUILD_ID` are empty, ask the user for them in this order:

1. **Bot token** — Discord developer portal → their app → Bot tab → Reset Token
2. **Application ID** — same portal → General Information
3. **Server (Guild) ID** — Discord client (Developer Mode on) → right-click server → Copy ID

Edit `.env` to fill in the values. Don't print the token back to the user.

Also check **MESSAGE CONTENT INTENT** — remind the user to enable it in Discord developer portal → Bot tab → Privileged Gateway Intents (required for text-channel listening). Wait for confirmation before proceeding.

**2. Node dependencies.**

Run `npm install` in `${CLAUDE_PLUGIN_ROOT}`. If `node_modules/` already has the right deps, npm will be a no-op.

**3. Python sidecar.**

Check that `${CLAUDE_PLUGIN_ROOT}/sidecar/.venv/bin/python` exists. If not:
```
python3 -m venv sidecar/.venv
sidecar/.venv/bin/pip install --upgrade pip
sidecar/.venv/bin/pip install -r sidecar/requirements.txt
```
This is the slow step — faster-whisper + kokoro-onnx pull in ~700MB of wheels. Tell the user this will take a few minutes.

**4. Voice models.**

Run `bash ${CLAUDE_PLUGIN_ROOT}/scripts/download-models.sh`. Idempotent — skips models already on disk. Downloads:
- Silero VAD ONNX (~2.3 MB)
- Kokoro TTS ONNX (~325 MB)
- Kokoro voices (~28 MB)

**5. Register slash commands with Discord.**

`cd ${CLAUDE_PLUGIN_ROOT} && npm run register`

This pushes `/pickup`, `/hangup`, `/say`, `/resume`, `/sessions`, `/rename`, `/bind`, `/unbind` to the user's Discord server. Idempotent.

**6. Verification.**

Print a summary:
- Discord token: set / not set (don't print the value)
- Node deps: installed
- Python venv: ready, with X MB of installed packages
- Models: present at `${CLAUDE_PLUGIN_ROOT}/models/` with sizes
- Slash commands: registered

Tell the user the next step is `/papercup:start`.

## Failure modes

- **npm install fails**: usually missing build tools for native deps. Surface the actual error; suggest `apt-get install build-essential python3-dev` on Linux.
- **pip install fails**: usually missing system libs. faster-whisper needs no extras; kokoro-onnx needs `espeak-ng` (`apt-get install espeak-ng` on Linux). Surface the error.
- **Model download fails**: usually network. Suggest re-running.
- **Discord token rejected on register**: bad token or app/guild id. Tell the user to double-check the values in `.env`.

Use the user's permission for each external command unless they say "go" / "proceed" / similar.
