# Troubleshooting

The bot is a layered pipeline; failures usually localize to one layer. Always start with the logs:

```sh
bash packages/bot/bin/papercup status
bash packages/bot/bin/papercup tail 50
```

Match the failure to a stage in [pipeline](/architecture/pipeline) and follow the recipe below.

## Boot failures

| Log line | Fix |
| --- | --- |
| `Used disallowed intents` | Enable **MESSAGE CONTENT INTENT** at Discord dev portal → Bot → Privileged Gateway Intents |
| `Missing required env var: DISCORD_TOKEN` | Edit `packages/bot/.env`, fill credentials |
| `Cannot find module ...` | `npm install` from repo root |
| `[stt] sidecar exited` | Python venv broken — `npm run setup-venv` |
| `Load model from .../silero_vad.onnx failed` | Run `npm run download-models` |
| `Not logged in · Please run /login` (claude-code backend) | `claude /login` from your terminal |

## Runtime failures

### Bot is silent on speech

Check VAD probabilities in logs. After speaking:

```
[debug] s16 peak: <high>, f32 peak: <high>
[debug] first probs: [<low values>...]
[capture] noise-only (speech<3); skipping playback
```

If `f32 peak` is healthy (>0.1) but VAD probs are all <0.05, suspect the Silero context buffer logic. If `f32 peak` is ~0 but `s16 peak` is healthy, suspect the resampler.

### Bot says "I can't access files"

By design — speaker has read-only tools and is told to delegate action work to extensions. To allow inline reads, set `PROJECT_DIRS=/path/to/your/project` in `.env` and restart. The speaker will then use Read/Glob/Grep on those paths.

### Latency is too high

Per-turn breakdown in logs:

```
[stt] req N: "..." (Xs audio in Ys, RTF=Z)
[agent] reply (Wms, ...)
[tts] req N: ... (Ums audio in Vs, RTF=...)
[agent] full loop: <total>ms
```

The agent step usually dominates with CLI backends. Switch to `AGENT_BACKEND=anthropic-api` with an API key for ~5s/turn savings.

### Korean / non-English not transcribed

`WHISPER_MODEL=base.en` is English-only. Switch to `base` for multilingual. Note: Kokoro doesn't have Korean voices, so the speaker will respond in English (or fail the language match) for Korean input.

### Capture loop stops responding mid-call

Capture self-heals on opus stream errors (DAVE decryption races, network glitches) by re-subscribing. If you ever see the bot go silent and `[capture] subscribing` doesn't show up after 1-2 seconds, that's a regression — file an issue with `papercup tail 100` output.

### Extension stuck running forever

Extensions inherit `--dangerously-skip-permissions` and can run unbounded. Check `cat packages/bot/data/extensions.json` for the entry — the pid is recorded. `kill <pid>` if it's truly hung; the on-exit handler will mark it failed.

## Diagnostic protocol via Claude Code plugin

If installed as a plugin, the `papercup` skill runs the diagnostic protocol for you. From inside Claude Code:

> "/papercup:status. The bot just stopped responding mid-call."

The skill walks the pipeline stages, reads the logs, and proposes the next debugging step.
