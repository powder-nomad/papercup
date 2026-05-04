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

### Agent hangs forever in text mode

Symptom: `/pickup mode:text`, send a message that needs a tool (Bash, Edit, etc.), no reply ever comes. Logs show the spawned `claude -p` process is alive but quiet.

Cause: claude is waiting on an interactive permission prompt that has nowhere to go (we run with piped stdio).

Fix: per-session permission policy. Text mode now defaults to `bypassPermissions`; if you see the hang, your session predates the fix or you set a stricter mode. Flip live with:

```
/permissions mode:bypassPermissions
```

If you want stricter control before going public, the right answer is the Discord-button UI (planned, not shipped). Until then, `bypassPermissions` is the only working choice for text mode that uses tools.

`/pickup mode:voice` uses `default` permissions and rarely hits prompts because the speaker mostly delegates to sandboxed extensions, which already run with `--dangerously-skip-permissions` in their own sandbox dirs.

### Latency is too high

Per-turn breakdown in logs:

```
[stt] req N: "..." (Xs audio in Ys, RTF=Z)
[agent] reply (Wms, ...)
[tts] req N: ... (Ums audio in Vs, RTF=...)
[agent] full loop: <total>ms
```

The agent step usually dominates with CLI backends. Switch to `AGENT_BACKEND=anthropic-api` with an API key for ~5s/turn savings.

### Korean / non-English not transcribed or spoken

For multilingual STT: `WHISPER_MODEL=small` (default for the auto/melotts/xtts TTS path) auto-detects 99 languages. `base.en` is English-only; if you see English transcripts when speaking Korean, you're on `base.en` — switch to `small` (better) or `base` (lighter).

For Korean output: set `TTS_ENGINE=auto` and pick the Korean engine via `TTS_KO_ENGINE=melotts` (faster, monotone) or `TTS_KO_ENGINE=xtts` (heavier, ~58 speakers, voice cloning). Kokoro alone can't speak Korean.

See [Korean](/components/korean) for the deep dive on tradeoffs.

### MeloTTS install fails

Upstream pins old `transformers==4.27.4` → `tokenizers 0.13.x` has no cp312 wheel → broken Rust source build. Don't `pip install` MeloTTS directly — use the helper:

```sh
bash packages/voice-stack/sidecar/install-melotts.sh packages/voice-stack/sidecar/.venv
```

It clones MeloTTS, unpins `transformers`, pre-installs CPU-only torch (avoids 3GB CUDA pull), and handles the post-install dance (setuptools<81 for `pkg_resources`, librosa bump, unidic dict download).

### Capture loop stops responding mid-call

Capture self-heals on opus stream errors (DAVE decryption races, network glitches) by re-subscribing. If you ever see the bot go silent and `[capture] subscribing` doesn't show up after 1-2 seconds, that's a regression — file an issue with `papercup tail 100` output.

### Extension stuck running forever

Extensions inherit `--dangerously-skip-permissions` and can run unbounded. Check `cat packages/bot/data/extensions.json` for the entry — the pid is recorded. `kill <pid>` if it's truly hung; the on-exit handler will mark it failed.

## Diagnostic protocol via Claude Code plugin

If installed as a plugin, the `papercup` skill runs the diagnostic protocol for you. From inside Claude Code:

> "/papercup:status. The bot just stopped responding mid-call."

The skill walks the pipeline stages, reads the logs, and proposes the next debugging step.
