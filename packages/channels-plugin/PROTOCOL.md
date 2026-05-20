# Channels MCP Protocol — Phase 0 recon

Concrete protocol notes from reading Anthropic's `claude-plugins-official`
discord + fakechat sources and the `code.claude.com/docs/en/channels-reference`
spec. Answers the six questions in `DESIGN.md` § "Phase 0 deliverable" and
flags where our planned architecture diverges from Anthropic's pattern.

## Sources read

- `external_plugins/discord/server.ts` (900 lines) — gateway-backed two-way
  channel with permission relay, pairing, allowlist, attachments
- `external_plugins/discord/.mcp.json`, `.claude-plugin/plugin.json`,
  `package.json`, `README.md`, `ACCESS.md`
- `external_plugins/fakechat/server.ts` (295 lines) — minimal localhost
  reference, same MCP contract minus the gateway
- `code.claude.com/docs/en/channels` (user-facing)
- `code.claude.com/docs/en/channels-reference` (protocol spec)

---

## 1. How does the plugin push events into claude?

**Standard MCP `notification`, method `notifications/claude/channel`.** The
plugin process calls `Server.notification()` from `@modelcontextprotocol/sdk`;
claude never polls. Stdio transport between claude and the plugin subprocess
carries the JSON-RPC frame.

Reference (discord/server.ts:875):

```ts
mcp.notification({
  method: 'notifications/claude/channel',
  params: {
    content,
    meta: { chat_id, message_id, user, user_id, ts, ... },
  },
})
```

To register the listener, the `Server` constructor must declare the
`claude/channel` capability — without it, claude drops the notifications
silently:

```ts
new Server({ name: 'discord', version: '1.0.0' }, {
  capabilities: {
    tools: {},
    experimental: { 'claude/channel': {} },
  },
  instructions: '...',
})
```

Delivery semantics (from the reference doc):

- Awaiting `mcp.notification()` resolves on transport write, **not** on claude
  acknowledgement. No retries, no acks.
- Events queue and are processed in order. If several arrive while claude is
  busy on a turn, they're batched into the next turn together.
- If the session isn't loaded with `--channels plugin:<name>` (or the
  `channelsEnabled` org policy is off), notifications are dropped silently.

## 2. Channel-event wire shape in the claude turn stream

The notification renders into claude's context as a single
`<channel>...</channel>` tag, where `source` is fixed to the MCP server's
configured `name` and every `meta` key becomes a string attribute:

```
<channel source="discord" chat_id="123..." message_id="456..." user="paul" user_id="789..." ts="2026-05-20T01:16:00.000Z">
the user's message text goes here
</channel>
```

For attachments, the discord plugin **lists** them in meta but does **not**
inline them — claude is told (via `instructions`) to call `download_attachment`
when it actually wants the file (discord/server.ts:875-890):

```ts
...(atts.length > 0 ? {
  attachment_count: String(atts.length),
  attachments: atts.join('; '),
} : {})
```

Constraints on `meta`:

- Values are `string` only — coerce numbers / booleans yourself
  (e.g. `String(atts.length)`).
- Keys must match `[A-Za-z0-9_]+`. Hyphenated keys are **silently dropped**
  (per the reference doc table for `meta`).
- The `instructions` string in the constructor is what teaches claude how to
  interpret the attributes — it goes into claude's system prompt. There is no
  schema enforcement; the plugin chooses the contract and documents it in
  `instructions`.

## 3. The `reply` mechanism

**`reply` is not channel-specific.** It is a plain MCP tool registered via
`ListToolsRequestSchema` + `CallToolRequestSchema`. The name and shape are
conventions of the official channel plugins, not a protocol requirement.

Discord plugin's shape (discord/server.ts:522-543):

```ts
{
  name: 'reply',
  description: 'Reply on Discord. Pass chat_id from the inbound message...',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: { type: 'string' },
      text: { type: 'string' },
      reply_to: { type: 'string' },          // message_id for threading
      files: { type: 'array', items: { type: 'string' } }, // absolute paths
    },
    required: ['chat_id', 'text'],
  },
}
```

Discord plugin additionally exposes `react`, `edit_message`, `fetch_messages`,
`download_attachment`. Fakechat exposes `reply` + `edit_message` only.

Implications for papercup:

- We can pick any tool name and any schema. The reply tool's job is to give
  claude a way to talk back; everything else is convention.
- Returning sent message IDs in the tool result is the established pattern
  (`{ content: [{ type: 'text', text: 'sent (id: ...)' }] }`).
- The plugin enforces chunking, file-size limits, and outbound auth (in the
  discord plugin, `fetchAllowedChannel` re-checks the allowlist before every
  send — see discord/server.ts:405-416).

## 4. Session-id discovery from the plugin process

**The plugin doesn't get the claude session UUID over the channels protocol.**
The MCP subprocess relationship is 1:1 with the claude process that spawned
it — there's no need for the plugin to identify "which claude" it's talking
to because stdio is already that binding.

Consequence for our design: the `PAPERCUP_SESSION_ID` env-var trick proposed
in `DESIGN.md` line 84-86 is the right answer, but it's our convention, not
something the channels protocol provides. The dispatcher sets the env when
spawning claude:

```ts
spawn('claude', ['--channels', 'plugin:papercup-channels', '--resume', uuid], {
  env: { ...process.env, PAPERCUP_SESSION_ID: uuid },
})
```

Env inherits from claude into the MCP subprocess automatically (verified by
the discord plugin reading `process.env.DISCORD_BOT_TOKEN` in
discord/server.ts:53). The plugin reads `PAPERCUP_SESSION_ID` at startup,
sends it in the `hello` frame over UDS, and the dispatcher uses it to route
events back to the right plugin connection.

`${CLAUDE_PLUGIN_ROOT}` is also available in `.mcp.json` args (resolved by
claude when spawning) — see discord/.mcp.json:5. Not directly useful for
session routing, but it's the documented way to reference the plugin's own
install directory.

## 5. `-p` + `--input-format stream-json` compatibility

**`--channels` works with `-p` non-interactive mode.** From the channels
overview:

> When you run channels in non-interactive mode with `-p`, tools that need
> terminal input, such as multiple-choice questions and plan mode approval,
> are disabled so the session never stalls waiting for input.

Permission prompts are the only friction:

- With `-p` and no `--dangerously-skip-permissions`, permission-gated tools
  fail closed (the tool call returns an error rather than blocking on a
  dialog that has no terminal to render in).
- Channel plugins that declare `claude/channel/permission` capability receive
  the prompt over MCP and can relay it (discord plugin does this — see
  discord/server.ts:445-518). For our MVP we should plan on
  `--dangerously-skip-permissions` and revisit relay in a later phase.

Stream-json input format is orthogonal to `--channels`; the channels are an
event-push side-channel, not part of the turn input stream. The reference
docs don't mention any incompatibility.

Practical implication: the per-session claude child can absolutely run
headless under `-p`, which matches what our dispatcher needs.

## 6. Plugin manifest + marketplace format

Three files at the plugin root. All three are required for a "plugin" install;
a bare `.mcp.json` works for ad-hoc development but can't be `/plugin install`-ed.

**`.claude-plugin/plugin.json`** — plugin manifest:

```json
{
  "name": "discord",
  "description": "Discord channel for Claude Code — messaging bridge ...",
  "version": "0.0.4",
  "keywords": ["discord", "messaging", "channel", "mcp"]
}
```

**`.mcp.json`** — how claude launches the MCP server:

```json
{
  "mcpServers": {
    "discord": {
      "command": "bun",
      "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"]
    }
  }
}
```

The `${CLAUDE_PLUGIN_ROOT}` token expands to the install directory.

**`package.json`** — runtime + entry point:

```json
{
  "name": "claude-channel-discord",
  "type": "module",
  "bin": "./server.ts",
  "scripts": { "start": "bun install --no-summary && bun server.ts" },
  "dependencies": { "@modelcontextprotocol/sdk": "^1.0.0", "discord.js": "^14.14.0" }
}
```

Activation flow:

1. `/plugin marketplace add <gh-org>/<repo>` registers a marketplace.
2. `/plugin install <name>@<marketplace>` copies/installs the plugin.
3. `/reload-plugins` (sometimes needed before slash commands appear).
4. **Restart with the channel flag**: `claude --channels plugin:<name>@<marketplace>`.

Allowlisting (research preview):

- Anthropic curates the default channel allowlist. Only plugins on it can
  load via plain `--channels`.
- For a custom plugin (our case), `--dangerously-load-development-channels
  plugin:<name>@<marketplace>` is the bypass during local development.
- Team/Enterprise orgs can set `allowedChannelPlugins` in managed settings
  to override the Anthropic list — relevant if we ever want to ship this as
  an internal-marketplace plugin without going through Anthropic.

Skills directory (`skills/`) is optional — discord ships one for
`/discord:access`. We can mirror this for `/papercup:bind` etc., but it's
not required by the channels protocol; standard `/plugin`-installed slash
commands are an independent feature.

---

## Architectural implications for DESIGN.md

Confirmed:

- The dispatcher-spawns-claude-children pattern is sound. Anthropic's
  discord plugin **embeds** the discord.js Gateway directly in the MCP
  subprocess; that's fine for a 1:1 user-to-bot mapping but breaks for our
  N-sessions-per-bot model (one bot token + N gateway connections =
  Discord-side conflicts). Our UDS bridge to a single dispatcher is the
  right deviation.

- `PAPERCUP_SESSION_ID` env-var injection from the dispatcher is the only
  practical handshake mechanism — channels protocol provides nothing for
  session correlation.

- Headless `-p` works, so dispatcher-spawned children can be fully
  unattended.

Things to revise in DESIGN.md (Phase 1 onwards):

- `instructions:` string is doing real work in the official plugins — it's
  the entire contract between meta keys and claude's behavior. Our plugin
  needs a carefully-written `instructions` block that documents the
  `<channel source="papercup" chat_id="..." user="..." ts="...">` shape and
  tells claude when to call our `reply` tool (and what to pass as
  `chat_id`).

- `meta` keys must be `[A-Za-z0-9_]+`. If we plan to encode anything like
  `discord-channel-id`, use `discord_channel_id` instead. Hyphens get
  silently dropped.

- `meta` values must be strings. `String(...)` everything.

- For Phase 5 (`/permissions` polish), the `claude/channel/permission`
  capability is the path forward — full protocol is in
  `channels-reference.md` § "Relay permission prompts" and a working
  implementation is in discord/server.ts:476-518 + 747-803. The
  request_id format `[a-km-z]{5}` is fixed by claude (no `l` for phone
  legibility).

- `reply` tool naming is free. We can keep it `reply` for convention, or
  call it `discord_send` / `papercup_reply` — doesn't matter to the
  protocol.

## Open items for Phase 1 — resolved

Resolved by inspecting the shipped `claude` 2.1.143 binary
(`~/.local/share/claude/versions/2.1.143`, strings-dump) plus the
channels-reference doc. Confidence levels noted per item; the rigs in
"Confirmation tests" below close the last ~10% if/when Phase 1 needs it.

### 1. Env-var inheritance into the MCP plugin subprocess — works ✅

Binary contains the spawn pattern:

```
spawn(..., { env: { ...process.env, CLAUDE_CODE_MCP_SERVER_NAME: H, CLAUDE_CODE_MCP_SERVER_URL: $.url, ... } })
```

`process.env` is spread, then claude adds two of its own keys on top. So
anything the dispatcher sets on `spawn('claude', { env })` flows through:

```
dispatcher process.env  →  spawn('claude', { env })  →  claude process.env  →  spawn(plugin, { env: { ...process.env, ... } })  →  plugin process.env
```

Independent confirmation: Discord plugin's
`process.env.DISCORD_BOT_TOKEN` reads work in production, and the README
explicitly says shell-env is a valid configuration path
(`README.md` step 5). That only works if inheritance is preserved.

**What the "plugin-spawned servers don't get an env block" comment in
discord/server.ts:43 actually means**: there is no `env: {...}` block in
the plugin's `.mcp.json` declaring extra vars to inject — not that env is
filtered. The discord plugin needs `.env` fallback only because the
plugin manifest can't carry secrets (it's checked into a public marketplace).
Papercup's dispatcher controls the spawn directly, so `env: {...}` on
`child_process.spawn` is sufficient — no `.env` file needed.

**Bonus discovery**: claude injects `CLAUDE_CODE_MCP_SERVER_NAME` into the
plugin's env automatically. The plugin can read this to know its registered
name without an extra var.

**Phase 1 action**: set `PAPERCUP_SESSION_ID` on the dispatcher's
`spawn('claude', { env: { ...process.env, PAPERCUP_SESSION_ID: uuid } })`
and read it as `process.env.PAPERCUP_SESSION_ID` in the plugin. No `.env`
fallback needed.

### 2. MCP subprocess crash behavior — no auto-respawn ✅

Grepping the binary for `respawn|restart|reconnect` next to MCP code paths
returns **zero matches**. The only "fail" string in MCP context is `MCP
reconcile fail` — that's plugin-install reconciliation at startup, not a
runtime crash recovery loop.

The channels-reference doc corroborates: when a subprocess dies, the user
diagnoses via `/mcp` (which "shows the server's status") and the prescribed
fix is to "check the debug log" — not "wait for auto-recovery."

**Consequence for the plugin design**: if the papercup plugin exits, the
channel is dead for the remainder of that claude session. The plugin must
therefore be crash-resistant from claude's point of view:

- **Never `process.exit()` on UDS errors.** Retry the dispatcher socket
  connection with exponential backoff. While disconnected, drop incoming
  reply tool calls with a graceful error (`{ isError: true, content: [...]
  text: 'dispatcher unavailable, retrying...' }`) rather than crashing.
- **Unhandled rejection handler** like discord/server.ts:68-73 — log and
  keep serving. The discord plugin does this exactly for the same reason.
- **Dispatcher-side**: if the dispatcher needs to push a fresh batch of
  events but the plugin's UDS connection is gone (peer died from some
  other cause), the dispatcher can't recover by itself. Reasonable fallback:
  kill the orphaned claude child (SIGTERM, then SIGKILL) and spawn a new
  one with `--resume`. See item 3.

**Out-of-scope for MVP but worth a flag**: per the binary,
`tengu_mcp_channel_enable` telemetry fires on successful registration. If
we ever need health monitoring, we could parse stderr / debug logs for
this event to confirm the plugin came up clean.

### 3. `--resume <uuid>` + `--channels` interaction — works, independent ✅

Grepping the binary for any string that couples `resume` with `channel`
returns nothing. They live in unrelated code paths:

- `--resume` loads the saved transcript + working state from
  `~/.claude/projects/.../<session-id>.jsonl`. Pure I/O.
- `--channels` registers MCP notification listeners during session
  initialization (binary string: `"Channel notifications registered"`,
  telemetry: `tengu_mcp_channel_enable`). Runs every launch regardless
  of resume.

So `claude --resume <uuid> --channels plugin:papercup-channels` does
exactly what we need: transcript restored, plugin starts fresh, plugin
re-registers `claude/channel`, the `instructions:` string is
re-injected into the system prompt, new events arrive as
`<channel source="papercup" ...>` tags into the resumed conversation.

**Caveat — clean turn boundary required**: if a previous turn ended with
a pending tool call (e.g. session was killed mid-tool-execution), resume
will pick up in an awkward state. Mitigation: the dispatcher's
idle-reaper should only kill claude children that are between turns, not
mid-execution. Detect this by reading the most recent line of the session
JSONL and confirming it's an `assistant` message with `stop_reason:
"end_turn"` (or similar) — not a `tool_use` block awaiting result.

**Phase 1 action**: dispatcher's reap-and-respawn flow is:

```
event arrives for channel C
  ↓
lookup session_id = bindings[C]
  ↓
is claude child alive?  →  yes → push event via UDS, done
  ↓ no
verify session JSONL ends on a clean turn boundary (else: refuse, surface error)
  ↓
spawn('claude', [..., '--resume', session_id, '--channels', 'plugin:papercup-channels'])
  ↓
wait for plugin's `hello` frame on UDS (timeout: ~10s)
  ↓
push event
```

---

## Confirmation tests (Phase 1, if needed)

The evidence above is high-confidence (binary inspection + protocol
docs + production code patterns). If Phase 1 hits a surprise, these three
tests close the last gap with minimal cost.

### Test A: env inheritance (no claude turn billed)

```sh
# /tmp/test-channel/.mcp.json
{ "mcpServers": { "envtest": { "command": "bun", "args": ["/tmp/test-channel/server.ts"] } } }

# /tmp/test-channel/server.ts (bun)
import { writeFileSync } from 'fs'
writeFileSync('/tmp/test-channel/env-snapshot.json', JSON.stringify({
  PAPERCUP_SESSION_ID: process.env.PAPERCUP_SESSION_ID ?? null,
  CLAUDE_CODE_MCP_SERVER_NAME: process.env.CLAUDE_CODE_MCP_SERVER_NAME ?? null,
  PATH_present: !!process.env.PATH,
  HOME_present: !!process.env.HOME,
}, null, 2))
// then connect MCP stdio normally; or just exit — health check still spawns it

# run (project root cwd):
cd /tmp/test-channel && PAPERCUP_SESSION_ID=phase1-test claude mcp list
cat /tmp/test-channel/env-snapshot.json   # expect PAPERCUP_SESSION_ID="phase1-test"
```

Pass criterion: file shows `PAPERCUP_SESSION_ID: "phase1-test"` and
`CLAUDE_CODE_MCP_SERVER_NAME: "envtest"`. No claude turn consumed
(`mcp list` only does a health-check spawn).

### Test B: crash behavior

Same `.mcp.json`; `server.ts` exits after 2 seconds. Run an interactive
`claude` session, send one prompt, wait 5 seconds, run `/mcp`. Verify the
server shows as "Failed" / "Disconnected" and is NOT re-spawned.

### Test C: resume + channels

Spawn `claude --session-id <uuid> --channels plugin:papercup-channels -p
"say hi"`. Capture `session_id`. Spawn again with `--resume <uuid>
--channels plugin:papercup-channels -p "what did you say last?"`. Verify:
(a) plugin starts fresh both times, (b) transcript carries over, (c) the
second invocation can still receive channel notifications (the plugin
exposes a tool that triggers an `mcp.notification` from a side channel,
e.g. a `/touch /tmp/event` file watcher).
