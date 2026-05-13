# Sessions

Named conversations that survive `/hangup`. Pick up later with `/resume name:<name>`.

## Slash commands

| Command | Effect |
| --- | --- |
| `/pickup` | New auto-named session (`call-2026-05-04-1234`), voice mode by default |
| `/pickup name:planning mode:text model:claude-opus-4-7 effort:high` | Named session with the full vibecoding setup, no voice join |
| `/hangup` | Closes the active container (voice line OR text chat); session preserved |
| `/resume name:planning` | Auto-mode — voice if you're in a voice channel, text if not |
| `/sessions` | List recent sessions (15 max), most recently active first |
| `/rename name:new-name` | Rename the active session |

See [Slash commands](/components/slash-commands) for the full surface (`/model`, `/effort`, `/permissions`, `/notify`).

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
      "backend": "claude-code",
      "mode": "text",
      "model": "claude-opus-4-7",
      "effort": "high",
      "permissionMode": "bypassPermissions",
      "notify": true
    }
  ]
}
```

| Field | Notes |
| --- | --- |
| `id` | Bot's stable internal handle (UUID) |
| `name` | Slugified human name |
| `backendId` | What the agent backend uses to resume. Usually `id` for `claude-code`; codex assigns its own thread UUID on first turn |
| `backend` | Which agent backend this session uses (`claude-code`, `openai-compat`, etc.). Survives bot restart and is honored by `/resume` |
| `mode` | `voice` or `text`. Drives system prompt + container choice on `/resume` auto-mode |
| `model` | Optional per-session model override (e.g. `claude-opus-4-7`). Falls back to `AGENT_MODEL` env |
| `effort` | Optional reasoning-effort hint. `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `permissionMode` | Optional tool-permission policy. `default` / `acceptEdits` / `auto` / `bypassPermissions` / `plan`. Mode-aware default applies when unset |
| `notify` | If true, extension settle events fire a TTS announcement (voice) or text message (text) |
| `streaming` | `off` (default) / `summary` / `full`. Per-session live progress UI for text turns. See [Slash commands → /streaming](/components/slash-commands#streaming-live-progress) |
| `reactivity` | `strict` (default) / `loose` / `chatty`. How this bot reacts to OTHER bots in the channel. See [multi-bot](/components/multi-bot) |
| `channelId` | For text sessions only: the Discord channel id this session is bound to. Set on auto-spawn so the bot can auto-resume the same session on the next message after a restart |

All optional fields are omitted from the JSON when unset — sessions migrate forward cleanly from earlier schema versions.

## Active containers

Two parallel runtime maps:

- `lines: Map<guildId, LineState>` — voice lines. One per guild. Holds the voice connection, audio player, speaker agent, last interaction.
- `textChats: Map<channelId, TextChat>` — text chats. One per channel. Holds the speaker agent and the session record.

`/pickup mode:voice` registers a `LineState`; `/pickup mode:text` registers a `TextChat`. `/hangup` removes whichever is active for this guild/channel. The session itself stays in `data/sessions.json` regardless.

## Hot-swap on `/model`, `/effort`, `/permissions`

These commands don't restart the bot or recreate the session. They:

1. Persist the new value on `Session` (e.g. `Session.model = "claude-opus-4-7"`)
2. Stop the current `SpeakerAgent` instance for the active container
3. Construct a new `SpeakerAgent` with the updated opts
4. Call `agent.start({ resume: true, ... })` so the backend continues from where it was

For backends with native sessions (claude-code, codex), backend resume preserves the full conversation history. For `anthropic-api`, history is in-memory; hot-swap loses prior turns. (Future fix: persist `anthropic-api` history alongside the session record.)

## Conversation history

The history itself lives wherever the agent backend stores it:

- **claude-code**: in `~/.claude/projects/<hash>/<session-id>.jsonl`. We pass `--session-id` on first turn, `--resume <id>` after.
- **codex**: in `~/.codex/sessions/<thread-id>/`. We capture the assigned thread id from the first JSONL output.
- **anthropic-api**: in-memory only (no persistence). Resuming an `anthropic-api` session today gives you a fresh slate — TODO: persist message history alongside the session record.

This is why the `backendId` field exists separately from `id`: backends with their own session stores need their own identifiers, and we have to track them.
