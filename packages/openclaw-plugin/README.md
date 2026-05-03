# @papercup/openclaw-plugin

Adds Papercup's local Kokoro TTS to OpenClaw as a `SpeechProviderPlugin`. Lets any OpenClaw channel (Discord, Slack, Telegram, etc.) synthesize voice locally — no cloud calls, no API key.

## What's implemented

- ✅ Plugin manifest (`plugin.json`)
- ✅ Plugin entry module exposing `OpenClawPluginDefinition`
- ✅ `papercup-kokoro` SpeechProviderPlugin
  - `synthesize(req)` — wraps `KokoroSidecar` from `@papercup/voice-stack`, returns WAV-wrapped 24 kHz mono audio
  - `listVoices()` — 23-voice curated subset spanning Kokoro v1.0's supported languages
  - `isConfigured()` — currently returns `true`; the sidecar reports model-missing errors on first synthesize
- ✅ Lazy sidecar boot (single shared instance for the OpenClaw runtime lifetime)
- ✅ WAV header writer

## What's NOT implemented yet

- ⏳ STT integration. Whisper is batch transcription; OpenClaw's `RealtimeTranscriptionProviderPlugin` is streaming-shaped. Need an adapter pattern (chunk audio + flush via VAD).
- ⏳ Per-call `providerConfig` plumbing. The synthesize path doesn't yet read voice/speed/lang from `req.providerConfig` — it uses the sidecar's env-var defaults. Need to either pass these through KokoroSidecar.synthesize or restart the sidecar with new env. Simpler approach: lift the per-call params into the sidecar protocol.
- ⏳ Real `isConfigured()` probe. Should check that the model files exist on disk before returning true.
- ⏳ Telephony synthesis (`synthesizeTelephony`). Lower-priority — most OpenClaw channels don't use it.
- ⏳ Integration test against an actual OpenClaw runtime.

## Layout

```
packages/openclaw-plugin/
├── plugin.json          OpenClaw manifest
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts         OpenClawPluginDefinition with register(api)
    ├── wav.ts           Mono s16 PCM → WAV buffer
    └── voices.ts        Curated Kokoro voice catalog
```

## Why a plugin

OpenClaw is a 247k-star personal AI assistant with adapters for 25+ messaging platforms. Its voice story today is platform-native speech (iOS Speech, Android SpeechRecognizer/TTS) — which works for native macOS/iOS/Android channels but doesn't apply to Discord, Slack, etc. where audio has to be synthesized server-side.

This plugin fills that gap: drop in `@papercup/openclaw-plugin`, get high-quality local TTS in any OpenClaw channel.

## Development

```sh
# from repo root
npm install
npm run typecheck --workspace=@papercup/openclaw-plugin
```

To test against a local OpenClaw install, point your OpenClaw config's plugin loader at this package directory. (TODO: document the exact loader config once we wire up an integration test.)

## Trying it (manual)

Until we have an integration test, the plugin's contract is verified against
the type definitions in the `openclaw` npm package. The provider class wraps
`KokoroSidecar` which is already exercised by the Papercup bot — so the
synthesize path is the same code path that's been in production use.
