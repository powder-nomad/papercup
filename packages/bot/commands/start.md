---
description: Start the Papercup bot daemon (background process). Idempotent — no-op if already running.
---

# Start Papercup

Run `bash ${CLAUDE_PLUGIN_ROOT}/bin/papercup start`.

This launches the bot as a detached background process via `setsid`. Logs go to `${CLAUDE_PLUGIN_ROOT}/logs/bot.log`. The pid is written to `${CLAUDE_PLUGIN_ROOT}/logs/bot.pid`.

After starting, wait 3-5 seconds and run `bash ${CLAUDE_PLUGIN_ROOT}/bin/papercup tail 20` to verify the boot sequence completed (look for `Cup ready as Papercup#... Waiting for /pickup.`).

## Common boot failures

- `Used disallowed intents` — user hasn't enabled MESSAGE CONTENT INTENT in Discord dev portal. Tell them to flip it then re-run.
- `Missing required env var: DISCORD_TOKEN` — `.env` not configured. Run `/papercup:setup`.
- `Cannot find module ...` — Node deps not installed. Run `npm install` from `${CLAUDE_PLUGIN_ROOT}`.
- `[stt] sidecar exited` — Python venv broken. Re-run `/papercup:setup`.

If start fails, show the user the last 30 lines of `logs/bot.log` and stop there — don't try to fix it without their input.
