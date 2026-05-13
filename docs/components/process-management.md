# Process management

Every CLI-agent turn (claude-code, codex, aider, gemini-cli, opencode, crush, amp) spawns a real OS process. Papercup needs to track them — to cancel cleanly, to recover from crashes without orphans, and to surface "what's actually running right now."

## The pieces

### Detached spawn

CLI agents are spawned with `detached: true`, making the child its own process-group leader. This is so the bot can SIGTERM the *whole tree* (claude + every grandchild it spawned — cloudflared, uvicorn, etc.) with one `process.kill(-pid, "SIGTERM")` call. Without detached, killing claude leaves its children alive — exactly the bug that produced a 20-hour zombie cloudflared once.

### Process registry

`data/process-registry.json` records every spawned PID:

```json
{
  "entries": [
    {
      "pid": 215593,
      "startedAt": 1762870276000,
      "sessionId": "6e510261-a6d3-4502-83d0-5b01890997f6",
      "botPid": 161422,
      "commandPreview": "claude: Go through the rest of Batch B steps…"
    }
  ]
}
```

Written through `ProcessRegistry.register()` right after each `spawn()`, unregistered on settle. Atomic write (tmp + rename). The bot identifies its own PID via `process.pid` so the boot reaper knows what was *previously* spawned (rows whose `botPid !== currentBotPid`).

### Boot-time reaper

On startup, `processRegistry.reapOrphans(process.pid)` walks the registry. For each entry with a different `botPid`:

1. `kill -0 pid` — is it still alive? If no, remove the entry.
2. Read `/proc/<pid>/cmdline` — does it look like `claude` (or the relevant CLI)? Guards against PID reuse: an unrelated process that happens to occupy a recycled PID won't get SIGTERM'd.
3. `process.kill(-pid, "SIGTERM")` — group-kill.
4. Remove the entry.

**Crucial safety rule:** the reaper only ever touches PIDs that are *in the registry*. It never `pgrep`s for `claude -p` globally — that would risk killing another operator's terminal claude, a parallel agent, or an MCP-spawned sub-claude.

### `/cancel`

Sends SIGTERM to the in-flight agent's process group for the active session. Works as long as the bot still holds a reference to the child (`ChildProcess`). If the reference was lost (e.g., the await Promise rejected unexpectedly), `/cancel` reports "Nothing in flight" — the registry + reaper covers that orphan once you restart.

### Per-turn timeout (optional)

`PAPERCUP_TURN_TIMEOUT_S` (default `0` = disabled) caps each turn at N seconds. On timeout, the same group-kill fires and the turn rejects with `turn timed out after Ns`. Disabled by default because legitimate work — install scripts, foreground cloudflared, long extension supervision — can outlast any reasonable cap; opt in when you want a safety net.

## Why the registry is in-band, not /tmp

Process tracking files in `/tmp` get cleaned up on reboot, exactly when they'd be most useful (to identify orphans surviving a crash). `data/` is durable; the registry survives unclean shutdowns.

## When the registry is helpful

- **Bot crashed mid-turn → claude kept running.** Restart the bot; the reaper finds the orphan via `botPid` mismatch + `/proc/cmdline` verification.
- **`/cancel` says "nothing in flight" but you can see a process.** Manual `kill <pid>` from terminal is safe — the registry only tracks, doesn't strictly require the entry to exist for cancel-by-PID-from-shell to work.
- **You want to audit what's running.** `cat data/process-registry.json` shows the live picture.

## Related

- [Slash commands → /cancel](/components/slash-commands#cancel)
- [Config → Process management](/config#process-management)
