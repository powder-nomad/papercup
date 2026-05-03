# Architecture

Papercup is a layered pipeline. Each layer is independent enough to swap or replace; failures usually localize to one stage.

## High-level

```
   ┌──────────────┐         ┌──────────────────────────────────────────┐
   │  Phone /     │         │              Homelab cup                 │
   │  desktop     │         │                                          │
   │              │         │  ┌──────────────┐    ┌──────────────┐    │
   │  Discord     │ opus  ──┼─▶│   Receiver   │    │   Player     │    │
   │  voice       │         │  │  (capture)   │    │  (playback)  │    │
   │              │ ◄──── opus │              │    │              │    │
   └──────────────┘         │  └──────┬───────┘    └──────▲───────┘    │
                            │         │ pcm               │ pcm        │
                            │         ▼                   │            │
                            │  ┌──────────────┐    ┌──────────────┐    │
                            │  │ VAD + STT    │    │     TTS      │    │
                            │  │ (Silero +    │    │ (Kokoro      │    │
                            │  │  Whisper)    │    │  via ONNX)   │    │
                            │  └──────┬───────┘    └──────▲───────┘    │
                            │         │ text              │ text       │
                            │         ▼                   │            │
                            │  ┌─────────────────────────────────┐     │
                            │  │   Speaker Agent                 │     │
                            │  │   (claude-code | codex | api)   │     │
                            │  │   tools: Read/Glob/Grep + MCP   │     │
                            │  └──────┬───────────────────▲──────┘     │
                            │         │ spawn_extension   │ summary    │
                            │         ▼                   │            │
                            │  ┌─────────────────────────────────┐     │
                            │  │   ExtensionManager + MCP        │     │
                            │  │   (HTTP MCP on 127.0.0.1)       │     │
                            │  └──────┬───────────────────▲──────┘     │
                            │         │ task              │ result     │
                            │         ▼                   │            │
                            │  ┌─────────────────────────────────┐     │
                            │  │   Extensions                    │     │
                            │  │   (background Claude Code in    │     │
                            │  │    per-id sandbox dirs)         │     │
                            │  └─────────────────────────────────┘     │
                            └──────────────────────────────────────────┘
```

## Why this shape

- **All-local voice.** No audio leaves the network. STT and TTS run on the same box as the bot.
- **Speaker on the latency-critical path.** Read-only inline tools. Heavy work is delegated.
- **Extensions are real subagents.** Not just tool calls — full Claude Code processes in their own dirs, autonomous, can run for minutes.
- **Pluggable backends, pluggable transports.** Same speaker code targets claude-code CLI, codex CLI, or Anthropic API. Same voice stack works for Discord today; OpenClaw's Discord adapter tomorrow.

## Read more

- **[Pipeline stages](/architecture/pipeline)** — what each stage does, expected logs, common failures
- **[Repo layout](/architecture/repo-layout)** — monorepo structure, how packages depend on each other
- **[Components](/components/voice-pipeline)** — deep dive on each subsystem
