# Extension subagents

Extensions are background Claude Code instances that run autonomously while you keep talking to the speaker. They live in `data/extensions/<id>/` sandbox directories, get full tool access (`--dangerously-skip-permissions --allowedTools default`), and persist results to disk.

## How a turn flows

1. User says "build me a Python script that prints fibonacci."
2. Speaker recognizes this is multi-step work and calls the MCP tool `spawn_extension({task: "..."})`.
3. `ExtensionManager.spawn()` creates `data/extensions/<id>/`, writes a record, spawns `claude -p "..."` with `cwd` set to the sandbox dir, returns the id immediately.
4. Speaker says "kicked that off, give me a sec" — extension id appears in `data/extensions.json`.
5. The `claude -p` subprocess runs in the background — could take 30s, could take 10 minutes.
6. When it exits, `ExtensionManager` parses the JSON output, captures the `result` text + `total_cost_usd`, marks the record `completed`.
7. User asks "is it done yet?" → speaker calls `check_extension(id)` → answers based on status.

## Tools exposed via MCP

| Tool | Purpose |
| --- | --- |
| `spawn_extension(task, name?)` | Kick off async work. Returns `{id, name, status: "running", dir, startedAt}`. |
| `check_extension(id)` | Get current status + summary. Pass id or friendly name. |
| `list_extensions(limit?)` | Recent extensions, most recent first. |

## Embedded HTTP MCP server

`packages/voice-stack/src/extensions/mcp-server.ts` is an in-process HTTP MCP server (Streamable HTTP transport from `@modelcontextprotocol/sdk`). The bot starts it at boot, picks an ephemeral localhost port, and passes the URL to every `claude -p` subprocess via `--mcp-config`:

```json
{
  "mcpServers": {
    "papercup": {
      "type": "http",
      "url": "http://127.0.0.1:<random-port>/mcp"
    }
  }
}
```

The server binds to `127.0.0.1` only — never exposed to the network. Sessions are per-request via the standard MCP session id header.

## Settled events + `/notify`

`ExtensionManager` extends `EventEmitter` and fires `"settled"` whenever an extension exits the running state (completed / failed / interrupted). The bot subscribes globally on boot:

```ts
extensions.on("settled", (ext) => {
  // Voice lines: speak a one-line completion notice if /notify is on.
  for (const [, state] of lines) {
    if (state.session.notify) void announceExtensionSettledVoice(state, ext);
  }
  // Text chats: drop a Discord message in the channel.
  for (const [channelId, chat] of textChats) {
    if (chat.session.notify) void announceExtensionSettledText(channelId, chat, ext);
  }
});
```

When `/notify state:on` is set on a session, settle events surface as:
- **Voice line** → TTS announcement: "Heads up — auth-deploy just finished after 4 minutes. Want the rundown?"
- **Text chat** → Discord message with the first 400 chars of the extension's `summary`

Off by default. See [Slash commands](/components/slash-commands#notify) for the exact toggle.

## Persistence

`data/extensions.json`:

```json
{
  "extensions": [
    {
      "id": "8d08ba4f",
      "name": "create-hello-txt",
      "task": "Create a file called hello.txt with the contents 'hi from papercup'",
      "status": "completed",
      "dir": ".../data/extensions/8d08ba4f",
      "pid": 793111,
      "startedAt": 1777694137387,
      "finishedAt": 1777694149658,
      "durationMs": 12271,
      "summary": "Created `hello.txt` at ...",
      "costUsd": 0.184
    }
  ]
}
```

Bot-process-bound: if the bot dies while an extension is running, it gets marked `interrupted` on next boot. We don't try to detach extensions across bot restarts (yet).

## Sandboxing today

Each extension runs in `data/extensions/<id>/` with `--dangerously-skip-permissions`. Inside the sandbox, full tool access. Outside: nothing — no `--add-dir` to user project paths by default. If you want extensions to operate on a real project, that's an [explicit config decision](/config) (TODO).

## Future direction

Per the design doc, extensions should eventually run in **git worktrees** of a target repo (so they can edit your project safely on a branch and you review the diff). The current implementation is the simpler v1.
