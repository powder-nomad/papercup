# Slash commands

Discord slash commands are how you drive Papercup at runtime. There are 12. The bot registers them per-guild on every restart (or via `npm run -w @papercup/bot register` after schema changes).

## Quick reference

| Command | What |
| --- | --- |
| `/pickup` | Start a session (voice or text) with optional `name`, `model`, `effort`, `permission-mode` |
| `/hangup` | End the active container (voice line OR text chat); session preserved for `/resume` |
| `/resume name:<x>` | Auto-mode resume — picks voice vs text from context |
| `/sessions` | List recent sessions |
| `/rename name:<x>` | Rename current session |
| `/say text:<x>` | Speak text via TTS into the active voice line |
| `/bind channel:<#chan>` | (Admin) Bind bot to a text channel — every message there triggers the bot |
| `/unbind` | (Admin) Drop the bind, fall back to @mention |
| `/model name:<x>` | Hot-swap the agent model on the active session |
| `/effort level:<x>` | Hot-swap the reasoning effort on the active session |
| `/permissions mode:<x>` | Hot-swap the tool permission policy |
| `/notify state:on\|off` | Toggle TTS/text alerts when a spawned extension settles |

## `/pickup` — start a session

The single entry point for starting a conversation. Voice or text, with optional knobs all set up front.

```
/pickup name:<string>?
        mode:voice|text                           (default: voice)
        model:<id>                                (e.g. claude-opus-4-7)
        effort:minimal|low|medium|high|xhigh|max
        permission-mode:default|acceptEdits|auto|bypassPermissions|plan
```

- **Voice mode** (default): joins your voice channel, applies the phone-call system prompt (terse, plain prose, Korean=1 sentence), uses TTS for replies.
- **Text mode**: pins a session to the current channel, no voice join. **No system prompt** — the agent behaves as a normal Claude Code session (markdown OK, multi-paragraph OK). Replies as Discord text. Composes with `/bind` — explicit `/pickup mode:text` takes over the auto-spawned chat in that channel.
- All four knobs (model/effort/permissionMode/mode) persist on the session and survive `/hangup` → `/resume`.
- Permission-mode default is mode-aware: `text` → `bypassPermissions` (vibecoding flow can't service interactive prompts); `voice` → `default` (speaker mostly delegates to sandboxed extensions).

## `/resume` — auto-mode

`/resume name:foo` figures out voice vs text from context:

1. Active voice line in this guild → resumes into voice
2. Active text chat in this channel → resumes into text (history preserved via backend resume)
3. `Session.mode` was saved → use it
4. You're currently in a voice channel → voice
5. Otherwise → text (safe default)

The decision is logged: `[resume] "vibe" → text (activeVoice=false activeText=true sessMode=text memberInVoice=false)`.

## `/hangup`

Ends whichever container is active for this guild/channel:
- Voice line → destroys the connection, marks session preserved
- Text chat → drops the chat, session preserved
- Neither → "No active line or text session here."

The session record stays in `data/sessions.json`; pick it back up with `/resume`.

## `/model`, `/effort`, `/permissions`

All three operate on the active container (voice line OR text chat) and **hot-swap the agent**: stop the current backend, restart it under the new opts, with `resume: true` so backend history carries over. No data loss.

```
/model name:claude-opus-4-7         # set model
/model name:                         # clear (falls back to AGENT_MODEL env)

/effort level:high                  # high reasoning budget
/effort level:default               # clear override

/permissions mode:bypassPermissions # vibecoding mode
/permissions mode:default-for-mode  # clear override (mode-aware default kicks in)
```

Persistence: each setting survives `/hangup` → `/resume`. Use the slash command without arguments isn't valid — Discord requires you specify the choice each time.

## `/notify`

When on, the bot announces extension settlement (completed / failed / interrupted) into your active container:
- Voice line → synthesizes a one-liner ("Heads up — auth-deploy just finished after 4 minutes. Want the rundown?") and plays it
- Text chat → posts a Discord message with the summary (first 400 chars)

```
/notify state:on
/notify state:off
```

Default is off; explicit on/off persists on the session.

## `/say`

Forces the bot to speak the given text into the active voice line. Useful for testing TTS or for one-off announcements that don't go through the agent.

```
/say text:Hello, this is a test of the TTS engine.
```

Errors if no voice line is active.

## `/bind` / `/unbind` (admin only)

Server-wide setting. When a channel is bound, every message there is treated as a prompt — no @mention required. The auto-spawned text chat for that channel is created on first message; you can replace it with `/pickup mode:text` for a named session.

Requires the **Manage Server** permission. State persists in `data/guild-config.json`.

## `/sessions` and `/rename`

```
/sessions             # show recent sessions, most-recently-active first
/rename name:vibe     # rename the current session
```

`/sessions` shows up to 15 entries with relative timestamps. Names are slugified (lowercase, hyphens). `/rename` errors if the new name collides.
