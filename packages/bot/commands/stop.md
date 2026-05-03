---
description: Stop the Papercup bot daemon.
---

# Stop Papercup

Run `bash ${CLAUDE_PLUGIN_ROOT}/bin/papercup stop`.

This kills the npm-run wrapper, all child tsx/node processes, and any leftover Python sidecars. Idempotent — no-op if not running.

After stopping, run `bash ${CLAUDE_PLUGIN_ROOT}/bin/papercup status` to confirm `stopped`.
