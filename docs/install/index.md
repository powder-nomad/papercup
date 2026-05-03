# Install Papercup

Three paths, all end with the same running bot. Pick whichever fits.

## Requirements

- **Node 20+** (the bot)
- **Python 3.10+** (Whisper + Kokoro sidecars)
- **espeak-ng** (Kokoro phonemizer dep) — `apt-get install espeak-ng` or `brew install espeak-ng`
- **build-essential + python3-dev** on Linux for native Node deps
- One of: `claude` CLI logged in, `codex` CLI logged in, or an **Anthropic API key**

## Disk + memory

| What | Disk |
| --- | --- |
| Node deps | ~250 MB |
| Python venv (faster-whisper + kokoro-onnx) | ~700 MB |
| Voice models (Silero, Kokoro, voices) | ~355 MB |
| **Total** | **~1.3 GB** |

Memory: ~1 GB resident at idle, more under load.

## Pick your path

- **[One-liner installer →](/install/one-liner)** Fastest. Form on the home page generates a customized `bash <(curl ...)` command.
- **[Windows install →](/install/windows)** Native Windows + WSL2 paths via `install.ps1`.
- **[Claude Code plugin →](/install/cc-plugin)** Drive setup through `/papercup:setup` slash commands. Best if you live in Claude Code.
- **[Standalone (manual) →](/install/standalone)** Clone, npm, venv, models, .env — explicit step-by-step.
- **[OpenClaw plugin →](/install/openclaw)** Coming soon — Papercup's voice stack as an OpenClaw skill.
