# Slash commands

Discord slash commands are how you drive Papercup at runtime. There are 19. The bot registers them per-guild on every restart (or via `npm run -w @papercup/bot register` after schema changes).

## Quick reference

| Command | What |
| --- | --- |
| `/pickup` | Start a session (voice or text) with optional `name`, `model`, `effort`, `permission-mode` |
| `/hangup` | End the active container (voice line OR text chat); session preserved for `/resume` |
| `/resume name:<x>` | Auto-mode resume — picks voice vs text from context |
| `/cancel` | SIGTERM the in-flight agent process group for the active session |
| `/sessions` | List recent sessions |
| `/status` | Show active session's config + currently-running background extensions |
| `/rename name:<x>` | Rename current session |
| `/say text:<x>` | Speak text via TTS into the active voice line |
| `/bind channel:<#chan>` | (Admin) Bind bot to a text channel — every message there triggers the bot |
| `/unbind` | (Admin) Drop the bind, fall back to @mention |
| `/model name:<x>` | Hot-swap the agent model on the active session |
| `/effort level:<x>` | Hot-swap the reasoning effort on the active session |
| `/permissions mode:<x>` | Hot-swap the tool permission policy |
| `/backend name:<x>` | Switch the agent backend (claude-code, codex, gemini-cli, openai-compat, …). Resets conversation history |
| `/models action:list\|refresh` | Show known model→backend mapping; refresh re-fetches from provider APIs |
| `/notify state:on\|off` | Toggle TTS/text alerts when a spawned extension settles |
| `/mcp` | Show or change which MCP servers' tools the active session can call |
| `/streaming mode:off\|summary\|full` | Live progress UI for text-mode turns |
| `/reactivity mode:strict\|loose\|chatty` | How this bot reacts to messages from OTHER bots |
| `/budget [set_usd:<n>]` | Show today's USD + token usage; optionally set/disable daily cap |
| `/announce` | Post this bot's structured roster entry to the `#roster` channel |
| `/refresh-roster` | Re-scrape the `#roster` channel to rebuild the local roster |

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

## `/cancel`

SIGTERM the in-flight agent's process group (claude/codex/aider/etc. + any descendants it spawned — cloudflared, uvicorn, etc.). Works for the active session in this channel/guild. If `/cancel` returns "Nothing in flight," check `data/process-registry.json` and the system process list — for true orphans, the boot-time reaper handles cleanup after the next restart.

## `/status`

Ephemeral reply showing the active session's `model`, `effort`, `permissionMode`, `mode`, plus a count of currently-running background extensions across the bot (not just this session's).

## `/backend` — switch the agent backend

```
/backend                            # show current + list of 10 registered backends
/backend name:openai-compat         # switch this session to openai-compat
```

**Resets the conversation history** (cross-backend session-resume isn't possible — a claude-code session id is meaningless to codex or opencode). The persisted `session.backend` field survives bot restarts. See [speaker-agent](/components/speaker-agent#backends).

## `/models` — model catalog

```
/models                  # default action = list
/models action:list      # show known models grouped by provider
/models action:refresh   # re-fetch live model lists from Anthropic, OpenAI, Gemini APIs
```

Static catalog of common models ships with the bot. Live `refresh` requires the relevant API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` / `OPENAI_COMPAT_API_KEY`, `GEMINI_API_KEY`). Each model entry lists which backends can run it — e.g. `claude-opus-4-7 → [claude-code, anthropic-api]`.

## `/streaming` — live progress

```
/streaming                         # show current mode for the active session
/streaming mode:off                # default. final reply only
/streaming mode:summary            # sticky one-line "🤔 Edit: foo.ts · 4 tools · 12s elapsed"
/streaming mode:full               # sticky message + last 8 events scrolling, adjacent-duplicate collapse
```

Only applies to text-mode sessions and only for the `claude-code` backend (it's the only one that streams `tool_use` / `tool_result` events). Anti-bomb: edit-throttled to 1.5s, auto-skip for turns under 5s.

## `/reactivity` — multi-bot guardrails

```
/reactivity                        # show current + bot-loop counter
/reactivity mode:strict            # default. respond to other bots only when @-mentioned
/reactivity mode:loose             # respond to other bots without @-mention
/reactivity mode:chatty            # reserved — same as loose today
```

Human messages are unaffected — existing bound-channel / @-mention rules still apply. The bot-loop cap (`BOT_BOT_MAX_TURNS`, default 3) silences papercup after that many consecutive bot replies without a human turn. See [multi-bot](/components/multi-bot).

## `/budget` — cost tracking

```
/budget                            # show today's USD + tokens + 7-day breakdown
/budget set_usd:10                 # set daily cap to $10
/budget set_usd:0                  # disable cap
```

Cap resets at UTC midnight. When over budget, humans get an explicit "budget spent" reply; other bots are silently ignored. The bot's Discord rich-presence shows `46% of $10/day` live. Pricing covers Claude Opus/Sonnet/Haiku 4.x, GPT-5/4o/o3, Gemini 2.5; unknown models record tokens only.

## `/announce` and `/refresh-roster` — in-band bot roster

```
/announce                          # post this bot's roster entry to BOT_ROSTER_CHANNEL_ID
/refresh-roster                    # re-scrape that channel + check workdir overlap
```

Requires `BOT_ROSTER_CHANNEL_ID` env set. The announcement is a structured code-block message (`papercup-roster v1`) with bot_id, owner, workdir, reactivity, budget, fingerprint, public-key. Other operators' bots scrape the same channel to discover each other. No out-of-band coordination required. See [multi-bot](/components/multi-bot).
