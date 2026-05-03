# OpenClaw plugin

::: tip Implementation shipped
The `@papercup/openclaw-plugin` package now ships a real `SpeechProviderPlugin` impl wrapping Kokoro. Loader-config docs are still TBD pending a live OpenClaw integration test — open an issue if you'd like to be the first to wire it up.
:::

## Why a plugin

[OpenClaw](https://openclaw.ai/) is a 247k-star personal AI assistant with adapters for 25+ messaging platforms (Discord, Slack, WhatsApp, Telegram, Signal, Matrix, etc.). Its voice story today is platform-native speech (iOS Speech, Android SpeechRecognizer/TTS) — which works for the macOS/iOS/Android channels but doesn't apply to Discord.

Papercup's voice stack (Silero VAD + Whisper + Kokoro / MeloTTS / XTTS-v2) runs server-side and is exactly the missing piece for OpenClaw's Discord channel.

## What the plugin will provide

- Server-side STT for incoming Discord voice
- Server-side TTS for outgoing Discord voice
- Reuses the same `@papercup/voice-stack` package as the standalone bot
- Plugs into OpenClaw's existing Discord adapter without forking it

The extension subagent system (Claude Code subagents in sandboxes) is also packageable as an MCP plugin — OpenClaw consumes MCP-standard tools, so that part is mostly free.

## Track this

Watch the `@papercup/openclaw-plugin` package in the [GitHub repo](https://github.com/powder-nomad/papercup/tree/main/packages/openclaw-plugin) for progress.
