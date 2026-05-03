---
description: Show recent Papercup bot logs. Pass a number to control how many lines (default 50).
---

# Papercup Logs

Read `$ARGUMENTS` to see if the user passed a line count. If so, use it; otherwise default to 50.

Run `bash ${CLAUDE_PLUGIN_ROOT}/bin/papercup tail <N>`.

Show the user the output verbatim. If they want a live tail, tell them to run `bash ${CLAUDE_PLUGIN_ROOT}/bin/papercup logs` themselves in a terminal — that's a long-running follow command and shouldn't be invoked from a single Claude turn.

## Common log patterns

- `[capture] noise-only (speech<3); skipping playback` — VAD correctly rejecting silence/noise.
- `[agent] full loop: <N>ms (heard→spoke)` — successful conversational turn.
- `[ext <id>] completed in <N>ms` — extension finished.
- `[capture] opus stream error: ... DAVE` — Discord encryption hiccup; capture loop self-heals.
