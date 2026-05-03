# Repo layout

Monorepo with three workspaces:

```
papercup/
├── package.json                          ← workspaces root
├── tsconfig.base.json
├── install.sh                            ← universal installer
│
├── packages/
│   ├── voice-stack/                      ← @papercup/voice-stack
│   │   ├── src/
│   │   │   ├── vad/silero.ts             ← Silero VAD wrapper (ONNX)
│   │   │   ├── stt/whisper.ts            ← Whisper sidecar client
│   │   │   ├── tts/{index,kokoro}.ts     ← TtsEngine interface + Kokoro impl
│   │   │   ├── audio/{resample,upsample}.ts  ← 48kHz↔16kHz, mono↔stereo
│   │   │   ├── extensions/
│   │   │   │   ├── manager.ts            ← spawns + tracks background claude
│   │   │   │   └── mcp-server.ts         ← embedded HTTP MCP server
│   │   │   └── index.ts                  ← roll-up barrel
│   │   ├── sidecar/
│   │   │   ├── stt.py                    ← faster-whisper, stdio framing
│   │   │   ├── tts_kokoro.py             ← kokoro-onnx, stdio framing
│   │   │   └── requirements.txt
│   │   ├── scripts/download-models.sh
│   │   └── models/                       ← gitignored (~355MB)
│   │
│   ├── bot/                              ← @papercup/bot — Discord bot AND CC plugin
│   │   ├── .claude-plugin/plugin.json    ← CC plugin manifest
│   │   ├── commands/                     ← CC plugin slash commands
│   │   │   ├── setup.md
│   │   │   ├── start.md
│   │   │   ├── stop.md
│   │   │   ├── status.md
│   │   │   ├── logs.md
│   │   │   └── update.md
│   │   ├── skills/papercup/SKILL.md      ← troubleshooting skill
│   │   ├── src/
│   │   │   ├── index.ts                  ← Discord bot entry point
│   │   │   ├── agent/
│   │   │   │   ├── speaker.ts            ← SpeakerAgent (per-line)
│   │   │   │   ├── backend.ts            ← AgentBackend interface + factory
│   │   │   │   ├── backend-claude-code.ts
│   │   │   │   ├── backend-codex.ts
│   │   │   │   └── backend-anthropic-api.ts
│   │   │   ├── session/store.ts          ← named conversations
│   │   │   ├── config/guild-config.ts    ← per-guild bound channel
│   │   │   └── register-commands.ts
│   │   ├── bin/papercup                  ← daemon ops script
│   │   ├── data/                         ← gitignored runtime state
│   │   ├── logs/                         ← gitignored
│   │   └── .env.example
│   │
│   └── openclaw-plugin/                  ← @papercup/openclaw-plugin (stub)
│       └── src/                          ← TODO: voice stack adapter for OpenClaw
│
└── docs/                                 ← VitePress site → GH Pages
    ├── .vitepress/
    │   ├── config.ts
    │   ├── theme/index.ts
    │   └── components/InstallerWizard.vue
    ├── index.md
    ├── install/
    ├── architecture/
    └── components/
```

## Dependency direction

```
bot ─────► voice-stack
   │
openclaw-plugin ─► voice-stack
```

`voice-stack` is the reusable core (VAD/STT/TTS/audio + extension MCP). Both consumers depend on it but not on each other.

## Build / run

```sh
# from repo root
npm install                               # all workspaces
npm run start                             # alias for @papercup/bot start
npm run register                          # alias for slash command register
npm run typecheck                         # all workspaces
npm run download-models                   # voice-stack/scripts/download-models.sh
npm run setup-venv                        # voice-stack/sidecar/.venv
```

Per-package: `npm run <script> --workspace=@papercup/bot`.
