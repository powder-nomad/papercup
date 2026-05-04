# Security

Papercup runs an LLM agent as the bot's Linux user, with that agent's tools (Bash, Edit, Write, plus subagents) reachable from Discord chat. **Anyone who can message the bot can prompt the agent.** This page covers the trust model and the levers that make a deployment safe.

## Threat model in one paragraph

Discord auth is the outer perimeter. Inside that, **prompt injection** can drive the agent to do whatever is reachable via its tool surface. The bot's Linux user (and the bot's working directory, environment, and `PROJECT_DIRS`) is the inner perimeter. There's no "the agent should refuse" defense — the agent will try to be helpful. Lock down what's reachable instead.

## Code-level audit (good)

The code itself is free of classical command injection:

- All `spawn()` calls use **array-form arguments** — never shell-interpreted strings
- Zero `shell: true`
- Zero `child_process.exec()` (the shell-eval'd one)
- Zero `eval()` / `new Function()`

Even crafted user input like `"; rm -rf /; "` reaches the LLM as plain text, not a shell. The risks below are LLM-level, not code-level.

## Required: user allowlist

Set this **before any deployment that exposes the bot to other Discord users**:

```env
BOT_ALLOWED_USERS=1452485937756901519,179823948572394857
```

Comma-separated Discord user IDs. When set:
- Slash commands from anyone else get a refusal reply
- Channel messages from anyone else are silently ignored

Empty/unset is the default for backward compat (allow everyone). If you've added the bot to any server you don't fully control, set the allowlist.

## Extension sandbox

`spawn_extension` runs a background `claude -p` as the bot's Linux user. Three env knobs control how locked-down it is:

| Var | Default | Notes |
| --- | --- | --- |
| `EXTENSION_PERMISSION_MODE` | `bypassPermissions` | `default` / `acceptEdits` / `auto` / `bypassPermissions` / `plan`. Default skips all permission checks (extensions run unattended; default/acceptEdits would hang on dangerous tools). Pair `default` with explicit `EXTENSION_ALLOWED_TOOLS` for tighter control. |
| `EXTENSION_ALLOWED_TOOLS` | `default` | Whitelist. e.g. `"Read Edit Write Bash(npm *) Bash(git *)"` — extension only gets these. |
| `EXTENSION_DISALLOWED_TOOLS` | — | Explicit denies. e.g. `"WebFetch Bash(curl *) Bash(rm -rf *)"` to block exfiltration + nukes. Same syntax as allowed. |

For a reasonably hardened deployment:

```env
EXTENSION_PERMISSION_MODE=default
EXTENSION_ALLOWED_TOOLS=Read Edit Write Bash(npm *) Bash(git *) Bash(node *) Bash(pnpm *)
EXTENSION_DISALLOWED_TOOLS=WebFetch
```

Extensions sandbox by `cwd` to `data/extensions/<id>/` and pass `--add-dir` for that path. With `default` permission mode, claude will refuse writes outside the sandbox + add-dir. With `bypassPermissions`, it ignores the scope.

## Speaker permission policy

The same `--permission-mode` flag drives the **speaker** itself (text-mode vibecoding):

- Voice mode default: `default` (speaker mostly delegates to extensions; rare bash)
- Text mode default: `bypassPermissions` (vibecoding flow can't service interactive prompts; piped stdio means prompts hang)

Per-session override via `/permissions mode:<choice>`. See [Slash commands](/components/slash-commands#model-effort-permissions).

## Secrets

The bot reads `packages/bot/.env` — Discord token, optional Anthropic API key. Two boundary considerations:

1. **The agent's Read tool can grab any file in `cwd`, `--add-dir` paths, or `PROJECT_DIRS`.** If `.env` is in `cwd` (it is) and the speaker has Read access (it does), prompt injection can exfiltrate the token via a reply.
2. **Don't put `.env` under `PROJECT_DIRS`** — that's the speaker's read scope for inline file lookups.

For homelab deployments where you're the only allowed user, the practical risk is low. For public/shared deployments:
- Keep `BOT_ALLOWED_USERS` populated
- Run the bot as a dedicated Linux user (e.g. `papercup`) with minimal home-dir contents
- Store `.env` outside the bot's `cwd` and pass via systemd/process env instead of `dotenv/config`
- Rotate `DISCORD_TOKEN` and `ANTHROPIC_API_KEY` if the bot ever ran without an allowlist on a public server

## Network surface

- **Discord WebSocket** (outbound): how the bot receives messages and sends replies
- **HF / model downloads** (outbound): one-time on first install
- **Embedded MCP server** (inbound): bound to `127.0.0.1` only, ephemeral port. Only the bot's child claude processes connect to it. Never exposed to LAN/internet.
- **No inbound HTTP** otherwise. The bot doesn't open any listening ports beyond the localhost MCP server.

## Discord channel scoping

`/bind` makes the bot listen to **every** message in a channel. If your bound channel is not gated by Discord role permissions, anyone in the server can drive the agent. Combine `/bind` with:

1. A private/role-gated channel
2. `BOT_ALLOWED_USERS` populated
3. `EXTENSION_PERMISSION_MODE=default` + a tight `EXTENSION_ALLOWED_TOOLS` list

## Known weak points (not yet fixed)

- **No interactive permission UI in text mode.** Text-mode default is `bypassPermissions` because the alternative (`default`) hangs on prompts piped stdio can't service. The right fix is a [Discord button UI](https://github.com/powder-nomad/papercup/issues) that surfaces permission requests as `[Allow]/[Deny]` buttons. Tracked separately; required before any public deployment that uses text mode.
- **Anthropic API backend has no per-tool gate** — it relies on the system prompt to constrain behavior. Use it with `BOT_ALLOWED_USERS` populated.
- **Extension stdout is captured and displayed.** Long extension logs include tool output; if a malicious extension exfiltrated data via its summary, that data would be visible in `/sessions` listings and notification messages.

## Quick checklist

Before flipping the bot public, walk this list:

- [ ] `BOT_ALLOWED_USERS` is set
- [ ] `EXTENSION_PERMISSION_MODE` is `default` or `acceptEdits` (not `bypassPermissions`)
- [ ] `EXTENSION_DISALLOWED_TOOLS` includes `WebFetch` and obvious dangers
- [ ] `.env` permissions are `600`, owned by the bot's user only
- [ ] Bot runs as a dedicated unprivileged user with minimal home-dir contents
- [ ] `PROJECT_DIRS` does not include the bot's own directory
- [ ] If `/bind` is used, the channel is role-gated
- [ ] Tokens have been rotated since the last public-without-allowlist period (if any)
