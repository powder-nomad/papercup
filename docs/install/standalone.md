# Standalone install (manual)

Step-by-step if you'd rather not use `install.sh`. Same outcome.

## 1. Clone

```sh
git clone https://github.com/powder-nomad/papercup.git ~/papercup
cd ~/papercup
```

## 2. Discord credentials

```sh
cp packages/bot/.env.example packages/bot/.env
$EDITOR packages/bot/.env
```

Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`. Also enable **MESSAGE CONTENT INTENT** in the Discord developer portal (Bot tab → Privileged Gateway Intents).

## 3. Node deps

```sh
npm install
```

## 4. Python venv (the slow step)

```sh
python3 -m venv packages/voice-stack/sidecar/.venv
packages/voice-stack/sidecar/.venv/bin/pip install -r packages/voice-stack/sidecar/requirements.txt
```

Pulls faster-whisper + kokoro-onnx + their deps. ~700 MB. A few minutes on first install.

## 4b. (Optional) Install Korean TTS engine

Skip if you only want Kokoro (English / 7 other langs). For Korean TTS pick one:

```sh
# MeloTTS (lighter, monotone, single voice)
bash packages/voice-stack/sidecar/install-melotts.sh packages/voice-stack/sidecar/.venv

# XTTS-v2 (heavier, ~58 voices, voice cloning)
packages/voice-stack/sidecar/.venv/bin/pip install --no-cache-dir coqui-tts "transformers>=4.46,<5"
```

Set the corresponding env vars in `packages/bot/.env`:

```env
TTS_ENGINE=auto         # routes Korean to TTS_KO_ENGINE, others to Kokoro
TTS_KO_ENGINE=melotts   # or xtts
WHISPER_MODEL=small     # multilingual STT
```

See [Korean (and other languages)](/components/korean) for the deep dive.

## 5. Voice models

```sh
bash packages/voice-stack/scripts/download-models.sh
```

Idempotent — skips files already present. Downloads:

- `silero_vad.onnx` — 2.3 MB
- `kokoro-v1.0.onnx` — 325 MB
- `kokoro-voices-v1.0.bin` — 28 MB

## 6. Register slash commands

```sh
npm run register --workspace=@papercup/bot
```

Pushes `/pickup`, `/hangup`, `/say`, `/resume`, `/sessions`, `/rename`, `/bind`, `/unbind` to your Discord server.

## 7. Start the daemon

```sh
bash packages/bot/bin/papercup start
```

Logs at `packages/bot/logs/bot.log`. Verify with:

```sh
bash packages/bot/bin/papercup tail 30
```

You're looking for `Cup ready as Papercup#... Waiting for /pickup.` plus all the sidecar-online lines above it.

## 8. Use it

In Discord, join a voice channel and run `/pickup`. Speak. The bot responds.

See [Sessions](/components/sessions) for `/resume` and friends, and [Channel binding](/components/channel-binding) for routing text-channel messages.
