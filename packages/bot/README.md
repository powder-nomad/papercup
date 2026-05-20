# @papercup/bot — DEPRECATED

This package is the original Discord bot. As of the SessionTransport
unification (see `../channels-plugin/DESIGN.md`), all functionality lives in
`@papercup/channels-dispatcher`:

- One Discord gateway, one set of slash commands
- Two transports (`channels` for long-lived `claude --channels`, `per-turn`
  for `<cli> -p` with mid-turn interrupts)
- Seven pluggable CLI backends: claude-code, codex, gemini-cli, aider,
  opencode, crush, amp — switchable per session via `/bind backend:` or
  `/backend name:`

## What's still here, why

- `bin/papercup` — thin forwarding stub. Points at
  `../channels-plugin/dispatcher/bin/papercup`. Kept so existing muscle
  memory (`cd packages/bot && bin/papercup restart`) and cron entries keep
  working. New entries should target the canonical path directly.
- `data/` — operator state (sessions.json, guild-config.json,
  process-registry.json, bot-identity.json, budget.json, inbox/outbox).
  **Live state.** Do not delete without migration.
- `src/` — original bot source. Logically retired, but not yet deleted in
  case rollback is needed during the transition. The CLI backend drivers
  here have been copied (not moved) into
  `../channels-plugin/dispatcher/src/transports/backends/`.
- `.claude-plugin/` — Claude Code plugin manifest. Independent of the
  Discord bot; unaffected by retirement.

## Migration path

1. `bin/papercup status` confirms the dispatcher is running.
2. Run `cd ../channels-plugin/dispatcher && npm run register` once to
   register the new `/transport` and `/backend` slash commands.
3. Existing sessions in `data/sessions.json` are NOT migrated to the
   dispatcher's `~/.papercup-channels/sessions.json` automatically — they
   were a different schema. New sessions get created on the dispatcher
   side via `/bind`.

## When this directory finally goes

Once the operator confirms the dispatcher has been stable for some weeks
and `data/` has been archived if needed, delete:

- `packages/bot/src/`
- `packages/bot/skills/`
- `packages/bot/commands/`
- `packages/bot/package.json`
- `packages/bot/tsconfig.json`

Keep `bin/papercup` (the stub) and `data/` for as long as muscle memory
references the old path.
