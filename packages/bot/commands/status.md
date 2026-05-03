---
description: Show Papercup daemon status — running/stopped, pid, uptime, child processes.
---

# Papercup Status

Run `bash ${CLAUDE_PLUGIN_ROOT}/bin/papercup status`.

Report the result to the user. If running, list:
- pid
- uptime (etime column)
- child processes (tsx, node, python sidecars)

If stopped, suggest `/papercup:start`.
