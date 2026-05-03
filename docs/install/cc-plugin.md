# Install as a Claude Code plugin

Papercup ships with a `.claude-plugin/plugin.json` manifest. You can drive setup and lifecycle from inside a Claude Code session via `/papercup:` slash commands.

## Local install (today)

```sh
git clone https://github.com/powder-nomad/papercup.git ~/papercup
claude --plugin-dir ~/papercup/packages/bot
```

In the resulting Claude Code session:

```
/papercup:setup
```

That walks you through everything — Discord token, npm install, Python venv, model downloads, slash command registration. Idempotent; safe to re-run.

Then:

```
/papercup:start
```

Bot is now running. Other commands:

| Command | What it does |
| --- | --- |
| `/papercup:setup` | One-time setup (also re-runnable) |
| `/papercup:start` | Start the daemon |
| `/papercup:stop` | Stop the daemon |
| `/papercup:status` | Show pid + uptime + child processes |
| `/papercup:logs [N]` | Show the last N lines of `logs/bot.log` (default 50) |
| `/papercup:update` | `git pull` + reinstall changed deps + restart |

A troubleshooting skill ships with the plugin too — Claude can walk you through the diagnostic protocol mapped to each pipeline stage (gateway → voice → capture → VAD → STT → agent → TTS → playback).

## Marketplace install (future)

Once Papercup is published to a Claude Code plugin marketplace:

```
/plugin install papercup
```

No `--plugin-dir` flag, no manual clone. The marketplace handles distribution.

## How the plugin is structured

```
packages/bot/
├── .claude-plugin/plugin.json     ← the manifest
├── commands/
│   ├── setup.md                   ← /papercup:setup
│   ├── start.md
│   ├── stop.md
│   ├── status.md
│   ├── logs.md
│   └── update.md
└── skills/
    └── papercup/SKILL.md          ← troubleshooting
```

The plugin manifest references commands by relative path. Commands are markdown
prompts that tell Claude what to do — they typically run `bin/papercup <verb>`
under the hood via the Bash tool.
