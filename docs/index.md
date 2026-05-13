---
layout: page
title: Papercup — voice line to Claude Code
---

<div class="pc-hero">
  <div class="pc-hero-copy">
    <div class="pc-hero-tags">
      <span class="brand">v0.2 · korean live</span>
      <span class="green">all-local voice</span>
      <span>self-hosted</span>
      <span>MIT</span>
    </div>
    <h1>Pick up the phone.<br/>Talk to your homelab.</h1>
    <p class="lede">
      Papercup is a Discord voice bot that calls a <strong>Claude Code</strong> session running on your own box. Press <code>/pickup</code>, talk like it's a phone call, get spoken answers. No cloud STT/TTS, no audio leaves your network.
    </p>
    <OneLiner />
  </div>
  <div class="pc-hero-demo">
    <HeroCall />
  </div>
</div>

<div class="pc-section">
  <h2>What makes this different</h2>
  <p class="sub">Three things, all load-bearing.</p>
  <div class="pc-pillars">
    <div class="pc-pillar">
      <h3><span class="pc-icon">01</span>All-local voice stack</h3>
      <p>Silero VAD → faster-whisper STT → Kokoro/MeloTTS TTS, all running in Python sidecars on your hardware. Audio never leaves your LAN.</p>
      <span class="pc-stat">~3–8s loop on 4 cores</span>
    </div>
    <div class="pc-pillar">
      <h3><span class="pc-icon">02</span>Phone-call UX</h3>
      <p>Speak, pause, get a spoken reply. Hang up and resume by name later. Multilingual (English, Korean, JP, ZH, ES, FR, …) auto-routed per utterance.</p>
      <span class="pc-stat">9 languages today</span>
    </div>
    <div class="pc-pillar">
      <h3><span class="pc-icon">03</span>Subagents do real work</h3>
      <p>The speaker delegates to sandboxed background Claude Code instances via an embedded MCP server. You hang up; they keep coding.</p>
      <span class="pc-stat">spawn → check → list</span>
    </div>
  </div>
</div>

<div class="pc-section">
  <h2>Three ways to install</h2>
  <p class="sub">Same core, different distribution shape. Pick whichever fits your setup.</p>
  <div class="pc-paths">
    <a class="pc-path" href="/install/one-liner">
      <span class="pc-path-tag">recommended</span>
      <h3>One-liner</h3>
      <p>Paste, answer three Discord-token questions, done. Engine selection via flags or the wizard below.</p>
      <span class="pc-path-arrow">read more →</span>
    </a>
    <a class="pc-path" href="/install/cc-plugin">
      <span class="pc-path-tag">claude code plugin</span>
      <h3>As a plugin</h3>
      <p>Drop into <code>~/.claude/plugins</code>. Drives setup via <code>/papercup:setup</code> / <code>start</code> / <code>status</code> slash commands.</p>
      <span class="pc-path-arrow">read more →</span>
    </a>
    <a class="pc-path" href="/install/openclaw">
      <span class="pc-path-tag">openclaw</span>
      <h3>OpenClaw plugin</h3>
      <p>Adds Papercup's voice stack to OpenClaw's Discord channel adapter as a <code>SpeechProviderPlugin</code>.</p>
      <span class="pc-path-arrow">read more →</span>
    </a>
  </div>
</div>

<div class="pc-section">

## Configure your one-liner {#installer}

<InstallerWizard />

</div>

<div class="pc-section">

## How a call flows

```
┌─ Discord (phone / desktop) ─┐         ┌─────────── Homelab ───────────┐
│                             │  voice  │                               │
│  /pickup → speak → /hangup  │ ──────► │  Silero VAD → Whisper STT     │
│                             │         │       ↓                       │
│  bot speaks back            │ ◄────── │  Speaker agent (Haiku)        │
│                             │ Kokoro  │       ↓                       │
└─────────────────────────────┘         │  Kokoro / MeloTTS → audio     │
                                        │                               │
                                        │  spawn_extension(task) ───►   │
                                        │       Claude Code subagent    │
                                        │       in sandboxed dir        │
                                        └───────────────────────────────┘
```

The speaker handles the call directly. For anything bigger than a quick file
read, it spawns a background extension — a full Claude Code instance in its
own dir — and narrates progress while it works. You can hang up; resume the
session by name later (`/resume name:foo`).

</div>

<div class="pc-section">

## System requirements

Tested on a 4-core Linux homelab. macOS works for the base path; the MeloTTS (Korean) path is Linux-tested only.

| | Minimum | Recommended |
| --- | --- | --- |
| OS | Linux x86_64, macOS (Intel or Apple Silicon) | Ubuntu 22.04+ |
| Python | 3.10 | 3.12 |
| Node | 20 | 20+ |
| Disk (English-only, Kokoro) | 2 GB free | 4 GB free |
| Disk (with Korean / MeloTTS) | 4 GB free | 8 GB free |
| RAM | 2 GB free | 4 GB free |
| CPU | 2 cores | 4+ cores (real-time STT/TTS) |
| Network | Outbound HTTPS for model downloads | — |

### apt (Linux)

```sh
# Base install (Kokoro TTS only)
sudo apt-get install -y espeak-ng python3-venv

# + Korean / MeloTTS path
sudo apt-get install -y libmecab-dev mecab-ipadic-utf8 libssl-dev pkg-config
```

### brew (macOS)

```sh
brew install espeak-ng node python@3.12
# Korean path also needs:
brew install mecab mecab-ipadic openssl pkg-config
```

### What you also need running

- **Discord bot** with token, client ID, and a guild ID. Get from [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot. Enable **MESSAGE CONTENT INTENT** and **VOICE STATE** under "Privileged Gateway Intents".
- **One agent backend**: a logged-in `claude` CLI (Claude Code), `codex` CLI (ChatGPT), or an Anthropic API key. The wizard above lets you pick.

### What gets downloaded on first run

- Whisper model (~140 MB for `base`)
- Kokoro voice + voices.bin (~100 MB)
- Silero VAD (~1.7 MB)
- **If Korean enabled**: PyTorch CPU (~700 MB) at install time; Korean BERT (~440 MB) lazy-loaded on first Korean utterance

</div>

<div class="pc-section">

## Capabilities matrix

| Component | Today | Notes |
| --- | --- | --- |
| VAD | Silero | Only option |
| STT | Whisper | `small` (multilingual, default) auto-detects 99 languages; `base` / `base.en` / `small.en` available |
| TTS | Kokoro + MeloTTS + XTTS-v2 (`auto`) | Kokoro: en/ja/zh/es/fr/hi/it/pt. Korean → MeloTTS (light, monotone) or XTTS-v2 (~58 voices, voice cloning). Set via `TTS_KO_ENGINE` |
| Agent | 10 backends (7 CLI agents + 3 HTTP APIs) | claude-code · codex · aider · gemini-cli · opencode · crush · amp · anthropic-api · openai-compat · gemini-api. Switch via `/backend` at runtime. |
| Per-session config | model · effort · permissions · backend · streaming · reactivity · notify · mode | Set via `/pickup` flags or hot-swap mid-session via individual slash commands |
| Modes | Voice (phone-call prompt) + Text (vibecoding) | `/pickup mode:voice` or `mode:text`. Text mode drops the system prompt → normal Claude Code behavior |
| Reasoning effort | minimal · low · medium · high · xhigh · max | xhigh / max are Opus-only |
| Live progress | sticky message, optional event log | Text mode + `/streaming summary\|full`. Anti-bomb: edit-throttled, auto-skips short turns |
| Budget tracking | per-day USD + tokens, daily cap | `BOT_DAILY_BUDGET_USD` or `/budget set_usd:<n>`; live on bot's rich-presence |
| Process hygiene | detached spawn, group-kill cancel, boot-time reaper | Each agent turn tracked in `data/process-registry.json`; orphans cleaned up on restart |
| Multi-bot | loop cap, reactivity modes, in-band roster | Multiple operators can co-host bots in one channel; cap prevents bot-to-bot loops |
| Transport | Discord voice + text | Bind a single channel via `/bind`, or @-mention anywhere |

See **[Slash commands](/components/slash-commands)** for the runtime surface and **[Components](/components/voice-pipeline)** for the deep dive.

</div>
