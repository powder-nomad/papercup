# papercup-channels (plugin)

The Bun MCP plugin half of papercup-channels. Bridges between a claude
session (loaded via `--channels`) and the papercup-channels dispatcher
process (Discord gateway + UDS server).

## Lifecycle

1. claude spawns this server over stdio when the session starts with
   `--channels plugin:papercup-channels` (or the development equivalent).
2. The plugin reads `PAPERCUP_SESSION_ID` and `PAPERCUP_DISPATCHER_SOCK`
   from its env (set by the dispatcher on its `spawn('claude', ...)` call).
3. It dials the dispatcher's UDS socket and sends a `hello` frame.
4. From then on it shuttles:
   - dispatcher event frames → `mcp.notification('notifications/claude/channel', ...)`
   - claude `reply` tool calls → reply frames back to the dispatcher.

## Wire frames (NDJSON, one JSON per line)

Plugin → dispatcher:

```jsonc
{ "type": "hello", "session": "<uuid>", "pid": 12345 }
{ "type": "reply", "session": "<uuid>", "msgId": "m...", "chat_id": "<discord-channel-id>", "text": "...", "reply_to": "<discord-message-id>" }
{ "type": "log", "level": "info|warn|error", "msg": "..." }
```

Dispatcher → plugin:

```jsonc
{ "type": "event", "session": "<uuid>", "chat_id": "<discord-channel-id>", "content": "...", "meta": { "user": "...", "message_id": "...", "ts": "...", ... } }
{ "type": "shutdown", "session": "<uuid>" }
```

## Tools exposed to claude

| Tool   | Purpose |
| ------ | ------- |
| `reply` | Send a Discord message via the dispatcher. Args: `chat_id`, `text`, optional `reply_to`. |

Later phases will add `react`, `edit_message`, `fetch_messages`,
`download_attachment` to match Anthropic's discord plugin surface, plus
voice tools.

## Why this isn't Anthropic's discord plugin

Anthropic's plugin embeds the discord.js gateway client directly inside
the MCP subprocess (1 plugin = 1 gateway). That breaks for papercup's
N-sessions-per-bot model (one bot token + N gateway connections =
Discord-side conflicts). This plugin keeps the gateway in the
dispatcher and talks to it over UDS; each claude session gets its own
plugin subprocess sharing the single dispatcher.

See `../DESIGN.md` and `../PROTOCOL.md` for architecture and protocol
details.
