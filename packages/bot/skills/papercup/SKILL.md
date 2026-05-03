---
name: papercup
description: Use when the user reports a Papercup bug — bot not responding, voice not detected, transcription wrong, agent silent, extensions stuck. Walks through the layered diagnostic protocol.
---

# Papercup Troubleshooting

Papercup is a multi-stage pipeline. Each stage has a distinctive log signature; isolate the broken stage first, then drill in.

## Pipeline stages (in order)

1. **Discord gateway** — bot connects to Discord. Failure: `Used disallowed intents`, `Invalid token`, `WebSocket closed`.
2. **Voice connection** — bot joins voice channel after `/pickup`. Failure: stuck in `connecting → signalling`, never reaches `ready`.
3. **Audio capture** — bot subscribes to user's voice. Failure: no `[capture] first opus frame` after speaking.
4. **VAD** — speech detection. Failure: every utterance flagged `noise-only`.
5. **STT** — Whisper transcription. Failure: `[stt] sidecar exited`, empty transcripts on real speech.
6. **Speaker agent** — Haiku response. Failure: `[agent] llm failed`, agent says it can't do things it should.
7. **TTS** — Kokoro synthesis. Failure: `[tts] synth failed`, no audio playback after agent speaks.
8. **Audio playback** — bot speaks back. Failure: `[player] error`, audio silent on the call.

## Diagnostic protocol

Always start with:
```
bash ${CLAUDE_PLUGIN_ROOT}/bin/papercup status
bash ${CLAUDE_PLUGIN_ROOT}/bin/papercup tail 50
```

Map the most recent log lines to the stage that failed. Don't change anything yet.

### "Bot is not responsive"

Most common cause: capture loop got wedged on a DAVE decryption error and never re-subscribed. We fixed that, but if it recurs, check the last `[capture] subscribing to user ...` line and the lines after it.

If the bot booted fine but doesn't respond:
- Check `sessions list` (per-guild) — is there an active line?
- Check that the user is actually in a voice channel (Discord shows them)
- Check the user's mic isn't muted client-side

### "Korean / non-English not transcribed correctly"

`WHISPER_MODEL=base.en` is English-only by design. Switch to `WHISPER_MODEL=base` for multilingual. Note: Kokoro doesn't have Korean voices — speaker will reply in English (or fail) for Korean input. See README "Capabilities" matrix.

### "Agent says it can't do X (file write, run code, etc.)"

By design — speaker agent has read-only tools (Read, Glob, Grep) and a system prompt that delegates real work to extensions via `spawn_extension`. If the agent isn't spawning extensions when it should:
- Check `${PAPERCUP_MCP_URL}` is set in startup logs (`[mcp] tools available at ...`)
- Check `--allowedTools` includes the `mcp__papercup__*` tools (look in `src/agent/backend-claude-code.ts`)
- Try a more explicit user request: "spawn an extension to ..."

### "Extension stuck running forever"

Extensions inherit `--dangerously-skip-permissions`, so they can run unbounded. Check `cat ${CLAUDE_PLUGIN_ROOT}/data/extensions.json` for the entry. The pid is recorded — `kill <pid>` if it's truly hung. Mark it failed manually if the JSON wasn't updated.

### "Latency too high"

Per-turn loop: VAD wait (~600ms) + STT (~0.3 RTF) + agent (~5-8s for CLI backends, ~0.5-1.5s for direct API) + TTS (~0.5-0.85 RTF) + playback start. The CLI backends dominate. Switch to `AGENT_BACKEND=anthropic-api` with an API key for the fastest path.

## When to recommend `/papercup:update`

Only if the user's `bin/papercup tail` shows a known-fixed bug pattern. Otherwise leave their install alone.
