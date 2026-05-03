# Channel binding

Two ways to talk to the bot in text:

1. **@-mention anywhere** — bot replies wherever it's mentioned
2. **Bind a single channel** — every message in that channel is a prompt; bot ignores everything else

## Slash commands (admin-only)

| Command | Effect |
| --- | --- |
| `/bind channel:#papercup` | Bind the bot to a text channel |
| `/unbind` | Fall back to @-mention behavior |

Both require **Manage Server** permission. Discord enforces this via `setDefaultMemberPermissions(ManageGuild)` on the slash command; the bot also re-checks in code as defense in depth.

## Per-guild config

`packages/bot/data/guild-config.json`:

```json
{
  "guilds": {
    "<guild-id>": {
      "boundTextChannelId": "<channel-id>"
    }
  }
}
```

Persisted via atomic rename. Survives bot restarts.

## Routing rules

When a message arrives:

1. Skip bot messages, DMs (guild-only for now), and empty content.
2. **If guild has a bound channel** and the message is in it → take the entire message as a prompt.
3. **If guild has a bound channel** and message is in a different channel → ignore.
4. **If no bound channel** and the bot is `@`-mentioned → strip the mention, take the rest as a prompt.
5. Otherwise → ignore.

Once a prompt is extracted:

- If a `/pickup` voice line is active in that guild → route through the same speaker agent. Bot replies in the chat **and** speaks the answer over voice. (Drop a link in chat mid-call → bot can talk about it.)
- Otherwise → spin up (or reuse) a per-channel text-only `SpeakerAgent`. Replies in chat only.

## Env-var override

`BOT_TEXT_CHANNEL_ID` in `.env` is a global fallback for guilds with no per-guild binding. Useful if you only run in one server. The per-guild `/bind` setting always wins.

## Privileged intent

Reading message content outside DMs requires Discord's **MESSAGE CONTENT INTENT** privileged intent. Enable it at *Discord developer portal → your app → Bot → Privileged Gateway Intents*. Without it, the bot crashes on connect with `Used disallowed intents`.
