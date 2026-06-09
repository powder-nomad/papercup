# Papercup

> 한국어 README → [README.ko.md](./README.ko.md)

**Voice line to Claude Code, running on your homelab.**

Discord voice bot that calls a Claude Code (or Codex / Anthropic API) session on your own box. Press `/pickup`, talk like a phone call, get spoken answers. All-local voice stack — Silero VAD + faster-whisper STT + Kokoro/MeloTTS/XTTS-v2 TTS — no audio leaves your network.

📖 Full docs: [powder-nomad.github.io/papercup](https://powder-nomad.github.io/papercup/) (after GH Pages flips on)

---

## Quick start

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/powder-nomad/papercup/main/install.sh)
```

Windows (native PowerShell):

```powershell
iwr -useb https://raw.githubusercontent.com/powder-nomad/papercup/main/install.ps1 | iex
```

The installer prompts for three Discord values (token, client ID, guild ID) and runs everything else. Mac/Linux/WSL2 paths use the bash version; native Windows uses PowerShell.

Want flag-customized output? Use the [installer wizard](https://powder-nomad.github.io/papercup/#installer) on the docs site.

## What it does

- **`/pickup`** — bot joins your voice channel, starts listening
- Speak; after ~600ms of silence, Whisper transcribes, the speaker agent thinks, the response is spoken back
- **`/hangup`** — session preserved, can resume later by name (`/resume name:foo`)
- **Multilingual auto-routing** — Korean → MeloTTS or XTTS-v2; everything else → Kokoro. Whisper auto-detects language per utterance.
- **Subagents** — for anything bigger than a quick file read, the speaker spawns a sandboxed background Claude Code instance via an embedded MCP server. You hang up; they keep working.
- **Advanced Scheduler** — schedule time-deferred prompts (`/queue`) or recurring jobs (`/schedule`) using an embedded SQLite WAL engine.
- **Context Auto-Compact** — watches token accumulation in long-lived sessions and auto-compacts before context window exhaustion.

## Capabilities

| Component | Today | Notes |
|---|---|---|
| VAD | Silero | Only option |
| STT | Whisper | `base`/`base.en`/`small`/`small.en`. Default `small` for multilingual |
| TTS | Kokoro + MeloTTS + XTTS-v2 | Auto-routes ko → MeloTTS or XTTS-v2 (configurable); Kokoro for en/ja/zh/es/fr/hi/it/pt |
| Agent | **10 backends** (7 CLI agents + 3 HTTP APIs) | claude-code · codex · aider · gemini-cli · opencode · crush · amp · anthropic-api · openai-compat · gemini-api. Switch at runtime with `/backend`. |
| Live progress | sticky message, optional event log | `/streaming summary\|full` in text mode |
| Budget tracking | daily USD + tokens, hard cap | `BOT_DAILY_BUDGET_USD` or `/budget set_usd:<n>`; bot's rich-presence shows current % |
| Process hygiene | detached spawn, group-kill cancel, boot-time reaper | Each agent turn tracked in `data/process-registry.json`; orphans cleaned up on restart |
| Multi-bot | loop cap, reactivity modes, in-band roster | Co-host multiple papercup bots in one channel; cap prevents bot-to-bot loops |
| Transport | Discord voice + text | Per-guild bind via `/bind`, or @-mention anywhere |

## Three distribution shapes

Same core, different surface — pick whichever fits:

- **Standalone bot** — what the one-liner installs
- **Claude Code plugin** — drop into `~/.claude/plugins`, drives setup via `/papercup:setup` slash commands
- **OpenClaw plugin** — `SpeechProviderPlugin` for OpenClaw's Discord adapter

Details: [docs/install/](docs/install/).

## System requirements

- **OS**: Linux x86_64, macOS, or Windows (WSL2 recommended for full feature set)
- **Node 20+**, **Python 3.10+**
- **Disk**: ~2 GB (Kokoro only) to ~8 GB (with MeloTTS + XTTS Korean models)
- **RAM**: 2 GB minimum, 4 GB recommended
- **CPU**: 4+ cores recommended for real-time STT/TTS

Full requirements + apt/brew commands: [docs index → System requirements](https://powder-nomad.github.io/papercup/#system-requirements).

## How a call flows

```
┌─ Discord (phone / desktop) ─┐         ┌─────────── Homelab ───────────┐
│                             │  voice  │                               │
│  /pickup → speak → /hangup  │ ──────► │  Silero VAD → Whisper STT     │
│                             │         │       ↓                       │
│  bot speaks back            │ ◄────── │  Speaker agent (Haiku)        │
│                             │ Kokoro  │       ↓                       │
└─────────────────────────────┘         │  Kokoro / MeloTTS / XTTS      │
                                        │                               │
                                        │  spawn_extension(task) ───►   │
                                        │       Claude Code subagent    │
                                        │       in sandboxed dir        │
                                        └───────────────────────────────┘
```

## Repo layout

```
~/papercup/
├── install.sh / install.ps1           # universal flag-driven installers
├── docs/                              # VitePress site → GH Pages
├── packages/
│   ├── voice-stack/   @papercup/voice-stack    # shared VAD/STT/TTS/audio/extensions
│   ├── bot/           @papercup/bot            # Discord bot + .claude-plugin/
│   └── openclaw-plugin/ @papercup/openclaw-plugin  # SpeechProviderPlugin
└── .github/workflows/docs.yml
```

## License

[MIT](./LICENSE) © Paul Kim
