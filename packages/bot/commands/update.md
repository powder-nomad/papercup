---
description: Pull the latest Papercup code, reinstall deps, restart the daemon.
---

# Update Papercup

Update flow:

1. Stop the bot: `bash ${CLAUDE_PLUGIN_ROOT}/bin/papercup stop`
2. Pull latest: `cd ${CLAUDE_PLUGIN_ROOT} && git pull`. If not a git repo, tell the user updates need to come from the plugin marketplace's update mechanism.
3. Reinstall Node deps if `package.json` changed: `npm install`
4. Reinstall Python deps if `sidecar/requirements.txt` changed: `sidecar/.venv/bin/pip install -r sidecar/requirements.txt`
5. Re-download models if `scripts/download-models.sh` changed (the script is idempotent — re-running is safe but slow only on actual diffs)
6. Re-register slash commands: `npm run register`
7. Start: `bash ${CLAUDE_PLUGIN_ROOT}/bin/papercup start`

Diff `package.json`, `sidecar/requirements.txt`, and `scripts/download-models.sh` against the previous commit before deciding which steps to skip. Tell the user what changed.
