# Installing Papercup

Two ways. Both end with the same running bot — pick whichever fits your setup.

## A. As a Claude Code plugin (recommended)

You drive setup through `/papercup:` slash commands inside Claude Code. Easiest if you already have Claude Code.

### Local install (until the marketplace ships it)

```sh
git clone <papercup-repo-url> ~/papercup
claude --plugin-dir ~/papercup
```

In the Claude Code session that opens, run:

```
/papercup:setup
```

That walks you through Discord credentials, Node deps, Python sidecar, and model downloads. Then:

```
/papercup:start
```

Bot is now live. Other commands: `/papercup:status`, `/papercup:logs`, `/papercup:stop`, `/papercup:update`.

### Marketplace install (future)

```
/plugin install papercup
```

Then `/papercup:setup` from anywhere — no `--plugin-dir` flag needed.

## B. Standalone (no Claude Code plugin)

If you'd rather run the bot directly:

```sh
git clone <papercup-repo-url> ~/papercup
cd ~/papercup
bash setup.sh           # interactive setup
./bin/papercup start
```

Equivalent to running the plugin commands manually. Use `./bin/papercup {start|stop|status|logs|tail}` to manage the daemon.

## Requirements

- **Node** 20+ (for the bot)
- **Python** 3.10+ (for Whisper + Kokoro sidecars)
- **espeak-ng** (Linux: `apt-get install espeak-ng`) — required by Kokoro
- **build-essential** + **python3-dev** (Linux) — needed for some native Node deps
- **claude** CLI installed and logged in, OR an Anthropic API key (set `AGENT_BACKEND=anthropic-api` in `.env`)

## Disk footprint

- Node deps: ~250 MB
- Python venv: ~700 MB (PyTorch + ONNX runtime via faster-whisper deps)
- Models: ~355 MB
  - Silero VAD: 2 MB
  - Kokoro TTS ONNX: 325 MB
  - Kokoro voices: 28 MB
- Total: ~1.3 GB
