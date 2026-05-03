# Sessions

Named conversations that survive `/hangup`. Pick up later with `/resume name:<name>`.

## Slash commands

| Command | Effect |
| --- | --- |
| `/pickup` | New auto-named session (e.g. `call-2026-05-02-1832`), bot joins voice |
| `/pickup name:planning` | New session with the given name |
| `/hangup` | Bot leaves voice; **session is preserved**, can resume later |
| `/resume name:planning` | Resume the named session, bot rejoins voice |
| `/sessions` | List recent sessions (15 max), most recently active first |
| `/rename name:new-name` | Rename the active session |

## Storage

`packages/bot/data/sessions.json`:

```json
{
  "sessions": [
    {
      "id": "9d8a...",
      "name": "planning",
      "createdAt": 1777694137387,
      "lastActiveAt": 1777695201000,
      "backendId": "9d8a...",
      "backend": "claude-code"
    }
  ]
}
```

- `id` is the bot's stable internal handle
- `backendId` is what the agent backend uses to resume — usually equal to `id` for `claude-code` (which accepts pre-allocated UUIDs), but different for `codex` which assigns its own thread UUID on first turn
- `backend` records which backend created the session, so we can refuse cross-backend resume

## Per-line state

When a `/pickup` is active in a guild, a `LineState` record holds the open voice connection, the player, the speaker agent, and a reference to the Discord interaction so the status panel can keep updating. Hanging up tears down the connection but preserves the session record.

## Conversation history

The history itself lives wherever the agent backend stores it:

- **claude-code**: in `~/.claude/projects/<hash>/<session-id>.jsonl`. We pass `--session-id` on first turn, `--resume <id>` after.
- **codex**: in `~/.codex/sessions/<thread-id>/`. We capture the assigned thread id from the first JSONL output.
- **anthropic-api**: in-memory only (no persistence). Resuming an `anthropic-api` session today gives you a fresh slate — TODO: persist message history alongside the session record.

This is why the `backendId` field exists separately from `id`: backends with their own session stores need their own identifiers, and we have to track them.
