/**
 * Register the papercup-channels slash commands with Discord.
 *
 * Run via `npm run register`. Ported from packages/bot/src/register-commands.ts
 * with the Phase 2 subset only — phases 3-5 will add /effort, /model,
 * /permissions, etc.
 */

import 'dotenv/config'
import {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from 'discord.js'

const token = process.env.DISCORD_BOT_TOKEN
const clientId = process.env.DISCORD_CLIENT_ID
const guildId = process.env.DISCORD_GUILD_ID

if (!token || !clientId || !guildId) {
  console.error('Missing DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, or DISCORD_GUILD_ID in env.')
  process.exit(1)
}

const commands = [
  new SlashCommandBuilder()
    .setName('bind')
    .setDescription('(Admin) Bind THIS channel to a claude session — every message here routes to it.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o =>
      o
        .setName('name')
        .setDescription("Session name to bind. Omit to reuse this channel's session or create a fresh one.")
        .setRequired(false)
        .setMaxLength(60),
    )
    .addStringOption(o =>
      o
        .setName('transport')
        .setDescription(
          'Transport mode for new sessions. channels = long-lived; per-turn = phone-call-style interrupt UX.',
        )
        .setRequired(false)
        .addChoices(
          { name: 'channels (long-lived, default)', value: 'channels' },
          { name: 'per-turn (phone-call interrupts, no permission relay)', value: 'per-turn' },
        ),
    )
    .addStringOption(o =>
      o
        .setName('backend')
        .setDescription('Backend agent CLI. Defaults to claude-code. Non-claude backends require transport:per-turn.')
        .setRequired(false)
        .addChoices(
          { name: 'claude-code (default)', value: 'claude-code' },
          { name: 'codex (OpenAI Codex CLI)', value: 'codex' },
          { name: 'gemini-cli (Google Gemini CLI)', value: 'gemini-cli' },
          { name: 'aider', value: 'aider-cli' },
          { name: 'opencode', value: 'opencode-cli' },
          { name: 'crush (Charm)', value: 'crush-cli' },
          { name: 'amp (Sourcegraph)', value: 'amp-cli' },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('transport')
    .setDescription("(Admin) Switch this channel's bound session to a different transport. Kills + respawns.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o =>
      o
        .setName('mode')
        .setDescription('Transport mode')
        .setRequired(true)
        .addChoices(
          { name: 'channels (long-lived)', value: 'channels' },
          { name: 'per-turn (phone-call interrupts)', value: 'per-turn' },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('backend')
    .setDescription("(Admin) Switch this channel's bound session to a different backend CLI. Kills + respawns.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o =>
      o
        .setName('name')
        .setDescription('Backend agent CLI')
        .setRequired(true)
        .addChoices(
          { name: 'claude-code', value: 'claude-code' },
          { name: 'codex', value: 'codex' },
          { name: 'gemini-cli', value: 'gemini-cli' },
          { name: 'aider', value: 'aider-cli' },
          { name: 'opencode', value: 'opencode-cli' },
          { name: 'crush', value: 'crush-cli' },
          { name: 'amp', value: 'amp-cli' },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('unbind')
    .setDescription('(Admin) Unbind THIS channel — kills the claude child; session metadata is kept.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('sessions')
    .setDescription('List recent claude sessions (current channel binding marked).')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('rename')
    .setDescription('Rename the session bound to THIS channel.')
    .addStringOption(o =>
      o.setName('name').setDescription('New name').setRequired(true).setMaxLength(60),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Set the model for this channel\'s session. Suggestions are backend-aware.')
    .addStringOption(o =>
      o
        .setName('name')
        .setDescription('Model id. Type to see suggestions for this channel\'s backend, or leave blank to clear.')
        .setRequired(false)
        .setAutocomplete(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('models')
    .setDescription("List models known for a backend (defaults to this channel's current backend).")
    .addStringOption(o =>
      o
        .setName('backend')
        .setDescription('Backend agent CLI. Defaults to this channel\'s session backend.')
        .setRequired(false)
        .addChoices(
          { name: 'claude-code', value: 'claude-code' },
          { name: 'codex', value: 'codex' },
          { name: 'gemini-cli', value: 'gemini-cli' },
          { name: 'gemini-api', value: 'gemini-api' },
          { name: 'anthropic-api', value: 'anthropic-api' },
          { name: 'openai-compat', value: 'openai-compat' },
          { name: 'aider', value: 'aider-cli' },
          { name: 'opencode', value: 'opencode-cli' },
          { name: 'crush', value: 'crush-cli' },
          { name: 'amp', value: 'amp-cli' },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('effort')
    .setDescription('Set reasoning effort for this channel\'s session.')
    .addStringOption(o =>
      o
        .setName('level')
        .setDescription("Reasoning effort. 'default' clears the override.")
        .setRequired(true)
        .addChoices(
          { name: 'minimal', value: 'minimal' },
          { name: 'low', value: 'low' },
          { name: 'medium', value: 'medium' },
          { name: 'high', value: 'high' },
          { name: 'xhigh (Opus only)', value: 'xhigh' },
          { name: 'max (Opus only)', value: 'max' },
          { name: 'default (clear override)', value: 'default' },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('permissions')
    .setDescription('Set the tool permission policy for this channel\'s session.')
    .addStringOption(o =>
      o
        .setName('mode')
        .setDescription("Permission mode. 'default-for-mode' clears the override (uses bypassPermissions).")
        .setRequired(true)
        .addChoices(
          { name: 'default (prompt — needs permission relay)', value: 'default' },
          { name: 'acceptEdits', value: 'acceptEdits' },
          { name: 'auto', value: 'auto' },
          { name: 'bypassPermissions', value: 'bypassPermissions' },
          { name: 'plan (read-only)', value: 'plan' },
          { name: 'default-for-mode (clear override)', value: 'default-for-mode' },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('cancel')
    .setDescription('Abort the in-flight turn for this channel\'s session (kills the claude child).')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('voice-join')
    .setDescription("Bot joins your voice channel and routes your speech into the bound text channel's session.")
    .toJSON(),
  new SlashCommandBuilder()
    .setName('voice-leave')
    .setDescription('Bot leaves the voice channel. The claude session stays alive for text.')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Make the bot speak arbitrary text in the active voice line (debug).')
    .addStringOption(o =>
      o.setName('text').setDescription('Text to speak').setRequired(true).setMaxLength(500),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('compact')
    .setDescription("Summarise this channel's session into a new forked session seeded with the handoff.")
    .addStringOption(o =>
      o
        .setName('name')
        .setDescription("Session name to compact. Defaults to this channel's bound session.")
        .setRequired(false)
        .setMaxLength(60),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription("Switch this channel to a named session (create if missing). Mirrors `claude --resume`.")
    .addStringOption(o =>
      o
        .setName('name')
        .setDescription('Session name. New if not found.')
        .setRequired(true)
        .setMaxLength(60),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('pickup')
    .setDescription('Bot joins your voice channel + binds this text channel. One-step /bind + /voice-join.')
    .addStringOption(o =>
      o
        .setName('backend')
        .setDescription('Backend agent CLI. Defaults to PAPERCUP_VOICE_DEFAULT_BACKEND or gemini-cli.')
        .setRequired(false)
        .addChoices(
          { name: 'claude-code', value: 'claude-code' },
          { name: 'codex', value: 'codex' },
          { name: 'gemini-cli (voice default)', value: 'gemini-cli' },
          { name: 'aider', value: 'aider-cli' },
          { name: 'opencode', value: 'opencode-cli' },
          { name: 'crush', value: 'crush-cli' },
          { name: 'amp', value: 'amp-cli' },
        ),
    )
    .addStringOption(o =>
      o
        .setName('model')
        .setDescription('Model id. Type to see suggestions for the chosen backend.')
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption(o =>
      o
        .setName('effort')
        .setDescription('Reasoning effort (ignored by non-claude backends).')
        .setRequired(false)
        .addChoices(
          { name: 'minimal (voice default)', value: 'minimal' },
          { name: 'low', value: 'low' },
          { name: 'medium', value: 'medium' },
          { name: 'high', value: 'high' },
          { name: 'xhigh (Opus only)', value: 'xhigh' },
          { name: 'max (Opus only)', value: 'max' },
        ),
    )
    .addStringOption(o =>
      o
        .setName('transport')
        .setDescription('Transport mode. Defaults to PAPERCUP_VOICE_DEFAULT_TRANSPORT or per-turn (better for voice).')
        .setRequired(false)
        .addChoices(
          { name: 'per-turn (voice default — phone-call interrupts)', value: 'per-turn' },
          { name: 'channels (long-lived; warm cache, slower cold start)', value: 'channels' },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('hangup')
    .setDescription('Bot leaves the voice channel. Alias for /voice-leave (text session preserved).')
    .toJSON(),
]

const rest = new REST({ version: '10' }).setToken(token)

try {
  console.log(`Registering ${commands.length} guild commands…`)
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands })
  console.log('Done.')
} catch (err) {
  console.error('Failed to register commands:', err)
  process.exit(1)
}
