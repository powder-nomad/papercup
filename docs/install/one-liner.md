# One-liner installer

The form on the [home page](/) generates a `bash <(curl ...)` command preconfigured with your engine selections. Copy it, paste into your homelab terminal, follow the Discord credential prompts.

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/powder-nomad/papercup/main/install.sh) \
  --agent claude-code \
  --stt whisper-small \
  --tts auto \
  --voice af_heart
```

## All flags

```
--dir <path>              Install location. Default: $HOME/papercup
--branch <name>           Git branch. Default: main
--discord-token <token>   Bot token (otherwise prompted)
--discord-client-id <id>  Application ID (otherwise prompted)
--discord-guild-id <id>   Server ID (otherwise prompted)

--agent <name>            claude-code (default) | codex | anthropic-api
--model <name>            haiku (default), sonnet, opus, gpt-5, etc.
--anthropic-api-key <k>   Required only if --agent=anthropic-api

--vad <name>              silero (default; only option today)
--stt <name>              whisper-small (default for multilingual TTS) |
                          whisper-base (default for kokoro-only) |
                          whisper-small.en | whisper-base.en
--tts <name>              auto (default — Kokoro + Korean engine routing) |
                          kokoro (no Korean) | melotts (Korean, monotone) |
                          xtts (Korean, ~58 speakers, voice cloning)
--voice <name>            af_heart (default) — Kokoro voice. See voices below

--silence-ms <int>        End-of-utterance silence (ms). Default: 600
--vad-threshold <float>   Speech probability threshold. Default: 0.4

--skip-models             Don't download voice models
--skip-venv               Don't create the Python venv
--skip-register           Don't push slash commands to Discord
--no-start                Install only; don't start the daemon
--yes / -y                Accept all defaults; never prompt
```

::: tip Runtime knobs are separate
The `--model` install flag sets the **default** model for new sessions. Each session can override it at runtime via `/pickup model:<id>` or `/model name:<id>` — same for reasoning effort (`/effort`), tool permissions (`/permissions`), and extension-completion alerts (`/notify`). See [Slash commands](/components/slash-commands) for the full runtime surface.
:::

## What it does

The script is idempotent. Re-run it any time with different flags to reconfigure.

1. **Sanity check**: node 20+, python3, espeak-ng, claude/codex CLI present (warns if not). Extra apt-deps check (libmecab-dev, libssl-dev, pkg-config) when MeloTTS is in scope.
2. **Clone or update** `powder-nomad/papercup` into `--dir`
3. **Discord credentials**: takes from flags, then existing `.env`, then prompts
4. **Write `packages/bot/.env`** with everything you specified
5. **`npm install`** at the workspace root
6. **Python venv** at `packages/voice-stack/sidecar/.venv` (slowest step, ~700MB of wheels)
7. **MeloTTS install** (only when `--tts auto` or `--tts melotts`) via `install-melotts.sh` helper — adds ~1.3GB (torch+BERT). Handles upstream pin issues automatically.
8. **Download models** (Silero VAD, Kokoro TTS, Kokoro voices — ~355MB)
9. **Register slash commands** with your Discord server
10. **Print capability matrix** (which languages/voices actually work end-to-end)
11. **Start the daemon**

## After install

Manage the daemon:

```sh
bash $HOME/papercup/packages/bot/bin/papercup status
bash $HOME/papercup/packages/bot/bin/papercup logs    # tail -F
bash $HOME/papercup/packages/bot/bin/papercup tail 50
bash $HOME/papercup/packages/bot/bin/papercup stop
bash $HOME/papercup/packages/bot/bin/papercup restart
```

In Discord:

```
/pickup name:planning      ← fresh named session
/hangup                    ← session preserved
/resume name:planning      ← pick up later
/sessions                  ← list recent
/rename name:foo           ← rename current session
/bind channel:#papercup    ← admin: route all messages there to bot
/say text:hello            ← speak text via TTS
```
