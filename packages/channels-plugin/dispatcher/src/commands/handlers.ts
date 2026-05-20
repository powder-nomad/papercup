/**
 * Slash-command handlers for the dispatcher.
 *
 * Ported from packages/bot/src/index.ts (handleBind, handleUnbind,
 * handleSessions, handleRename) with channels-mode lifecycle semantics:
 *   - bind   → create session, persist mapping, spawn claude child
 *   - unbind → kill claude child, drop session.channelId, drop binding
 *
 * Phase 2 scope: bind, unbind, sessions, rename.
 * Phase 4 will add model/effort/permissions handlers with respawn semantics.
 */

import {
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js'
import type { CommandContext } from './types.ts'
import type { SessionTransportName } from '../state/sessions.ts'
import { compactSession } from '../compact.ts'

export async function handleBind(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  if (!interaction.guildId || !interaction.guild) {
    await interaction.editReply('Not in a guild.')
    return
  }
  const member = interaction.member
  if (!(member instanceof GuildMember) || !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.editReply('You need the **Manage Server** permission to bind a channel.')
    return
  }

  const channelId = interaction.channelId
  const nameOpt = interaction.options.getString('name') ?? undefined
  const transportOpt = (interaction.options.getString('transport') ?? undefined) as
    | SessionTransportName
    | undefined

  // If a name was given, look it up. Otherwise, prefer reattaching the
  // existing session on this channel (so /bind is also "reactivate").
  let target = nameOpt ? ctx.sessions.findByName(nameOpt) : ctx.sessions.findLatestForChannel(channelId)
  if (nameOpt && !target) {
    await interaction.editReply(
      `No session named "${nameOpt}". Omit \`name\` to create a fresh one, or /sessions to list.`,
    )
    return
  }
  if (!target) {
    target = await ctx.sessions.create({ channelId, transport: transportOpt })
  } else if (transportOpt && transportOpt !== target.transport) {
    // Existing session, but caller requested a different transport — apply it
    // and kill any running child so the next message respawns under the new
    // transport.
    ctx.killFor(target.id)
    const updated = await ctx.sessions.setTransport(target.id, transportOpt)
    if (updated) target = updated
  }

  // Keep channel↔session 1:1: clear channelId on any other session previously
  // bound here.
  for (const s of ctx.sessions.list()) {
    if (s.channelId === channelId && s.id !== target.id) {
      await ctx.sessions.setChannelId(s.id, undefined)
    }
  }
  await ctx.sessions.setChannelId(target.id, channelId)
  await ctx.guildConfig.addBoundChannel(interaction.guildId, channelId)

  ctx.spawnFor(target)

  console.log(
    `[bind] guild ${interaction.guildId} channel ${channelId} → session "${target.name}" (transport=${target.transport}) by ${member.user.tag}`,
  )
  await interaction.editReply(
    `🔗 This channel is now bound to session **${target.name}** (transport: \`${target.transport}\`). Every message here routes to it.`,
  )
}

/**
 * /transport mode:<channels|per-turn> — switch the bound session's transport.
 * Kills the running child (if any); next message respawns under the new
 * transport.
 */
export async function handleTransport(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  if (!interaction.guildId) {
    await interaction.editReply('Not in a guild.')
    return
  }
  const member = interaction.member
  if (!(member instanceof GuildMember) || !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.editReply('You need the **Manage Server** permission to change a session transport.')
    return
  }

  const target = ctx.sessions.findLatestForChannel(interaction.channelId)
  if (!target) {
    await interaction.editReply('No session bound to this channel. Run `/bind` first.')
    return
  }

  const mode = interaction.options.getString('mode', true) as SessionTransportName
  if (mode === target.transport) {
    await interaction.editReply(`Session **${target.name}** is already on transport \`${mode}\`. No change.`)
    return
  }

  ctx.killFor(target.id)
  const updated = await ctx.sessions.setTransport(target.id, mode)
  if (!updated) {
    await interaction.editReply('Session vanished between lookup and update — try again.')
    return
  }
  const note = mode === 'per-turn'
    ? ' Permission relay is disabled in per-turn mode (claude runs with --dangerously-skip-permissions).'
    : ''
  await interaction.editReply(
    `🔁 Transport set to \`${mode}\`. Claude child killed; next message respawns.${note}`,
  )
}

export async function handleUnbind(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  if (!interaction.guildId || !interaction.guild) {
    await interaction.editReply('Not in a guild.')
    return
  }
  const member = interaction.member
  if (!(member instanceof GuildMember) || !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.editReply('You need the **Manage Server** permission to unbind a channel.')
    return
  }

  const channelId = interaction.channelId
  const wasBound = ctx.guildConfig.isBound(interaction.guildId, channelId)
  await ctx.guildConfig.removeBoundChannel(interaction.guildId, channelId)

  // Kill the claude child for whatever session was on this channel.
  const session = ctx.sessions.findLatestForChannel(channelId)
  if (session) {
    ctx.killFor(session.id)
    await ctx.sessions.setChannelId(session.id, undefined)
  }

  console.log(`[unbind] guild ${interaction.guildId} channel ${channelId} by ${member.user.tag}`)
  await interaction.editReply(
    wasBound
      ? '🔓 This channel is unbound. The claude session is preserved — re-bind to resume.'
      : "This channel wasn't bound. No change.",
  )
}

export async function handleSessions(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const list = ctx.sessions.list().slice(0, 15)
  if (list.length === 0) {
    await interaction.editReply('No sessions yet. Run `/bind` in a channel to create one.')
    return
  }
  const rows = list.map(s => {
    const channel = s.channelId ? ` <#${s.channelId}>` : ''
    const idleMin = Math.floor((Date.now() - s.lastActiveAt) / 60_000)
    const status = ctx.isPluginOnline(s.id) ? '🟢' : '⚪'
    const extras = [
      `transport=${s.transport}`,
      s.model && `model=${s.model}`,
      s.effort && `effort=${s.effort}`,
      s.permissionMode && `perm=${s.permissionMode}`,
    ].filter(Boolean).join(' ')
    return `${status} **${s.name}**${channel} — idle ${idleMin}m${extras ? `  ·  ${extras}` : ''}`
  })
  await interaction.editReply(rows.join('\n'))
}

export async function handleRename(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const channelId = interaction.channelId
  const target = ctx.sessions.findLatestForChannel(channelId)
  if (!target) {
    await interaction.editReply('No session bound to this channel. Run `/bind` first.')
    return
  }

  const newName = interaction.options.getString('name', true)
  try {
    const updated = await ctx.sessions.rename(target.id, newName)
    await interaction.editReply(`✏️ Renamed to **${updated.name}**.`)
  } catch (err) {
    await interaction.editReply(`❌ ${(err as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// Phase 4: knobs. Each handler updates the persisted session config and kills
// the claude child so the next inbound message respawns with new flags.
// ---------------------------------------------------------------------------

async function sessionForCurrentChannel(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
) {
  const target = ctx.sessions.findLatestForChannel(interaction.channelId)
  if (!target) {
    await interaction.editReply('No session bound to this channel. Run `/bind` first.')
    return undefined
  }
  return target
}

export async function handleModel(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  const target = await sessionForCurrentChannel(interaction, ctx)
  if (!target) return

  const name = interaction.options.getString('name') ?? undefined
  const updated = await ctx.sessions.setModel(target.id, name)
  if (!updated) {
    await interaction.editReply('Session vanished between lookup and update — try again.')
    return
  }
  ctx.killFor(updated.id)
  await interaction.editReply(
    name
      ? `🔁 Model set to **${updated.model}**. Claude child killed; next message respawns with the new flag.`
      : `🔁 Model override cleared (back to CLI default). Claude child killed; next message respawns.`,
  )
}

export async function handleEffort(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  const target = await sessionForCurrentChannel(interaction, ctx)
  if (!target) return

  const level = interaction.options.getString('level', true)
  const effort = level === 'default' ? undefined : (level as NonNullable<typeof target.effort>)
  const updated = await ctx.sessions.setEffort(target.id, effort)
  if (!updated) {
    await interaction.editReply('Session vanished between lookup and update — try again.')
    return
  }
  ctx.killFor(updated.id)
  await interaction.editReply(
    effort
      ? `🔁 Effort set to **${effort}**. Claude child killed; next message respawns.`
      : `🔁 Effort override cleared. Claude child killed; next message respawns.`,
  )
}

export async function handlePermissions(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  const target = await sessionForCurrentChannel(interaction, ctx)
  if (!target) return

  const mode = interaction.options.getString('mode', true)
  const value = mode === 'default-for-mode'
    ? undefined
    : (mode as NonNullable<typeof target.permissionMode>)
  const updated = await ctx.sessions.setPermissionMode(target.id, value)
  if (!updated) {
    await interaction.editReply('Session vanished between lookup and update — try again.')
    return
  }
  ctx.killFor(updated.id)
  await interaction.editReply(
    value
      ? `🔐 Permission mode set to **${value}**. Claude child killed; next message respawns. ` +
        `⚠️ If the policy needs interactive approval (\`default\`, \`plan\`), the bot relays prompts via Discord buttons when permission relay is enabled.`
      : `🔐 Permission override cleared (back to \`bypassPermissions\`). Claude child killed; next message respawns.`,
  )
}

export async function handleCancel(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  const target = await sessionForCurrentChannel(interaction, ctx)
  if (!target) return

  const killed = ctx.killFor(target.id)
  await interaction.editReply(
    killed
      ? `🛑 Aborted in-flight turn for **${target.name}**. Next message respawns the session.`
      : `Nothing to abort — no claude child running for **${target.name}**.`,
  )
}

// ---------------------------------------------------------------------------
// Phase 3: voice. /voice-join attaches a Discord voice connection to the same
// session that's bound to the text channel of the slash command. Transcripts
// flow through the existing event path (with meta.source=voice); replies are
// optionally TTS-synthesized back when a voice line is active.
// ---------------------------------------------------------------------------

export async function handleVoiceJoin(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  if (!ctx.voice) {
    await interaction.editReply(
      '🔇 Voice is unavailable — the Whisper sidecar failed to start at boot. Check dispatcher logs.',
    )
    return
  }
  if (!interaction.guild || !interaction.guildId) {
    await interaction.editReply('Not in a guild.')
    return
  }
  const member = interaction.member
  if (!(member instanceof GuildMember)) {
    await interaction.editReply("Couldn't resolve your guild membership.")
    return
  }
  const voiceChannel = member.voice.channel
  if (!voiceChannel) {
    await interaction.editReply('Join a voice channel first, then call `/voice-join` from the bound text channel.')
    return
  }
  const session = ctx.sessions.findLatestForChannel(interaction.channelId)
  if (!session) {
    await interaction.editReply("This text channel isn't bound. Run `/bind` here first.")
    return
  }
  if (ctx.voice.has(interaction.guildId)) {
    await interaction.editReply('Already on a voice line in this guild. Run `/voice-leave` first.')
    return
  }

  try {
    await ctx.voice.join({
      sessionId: session.id,
      guildId: interaction.guildId,
      voiceChannelId: voiceChannel.id,
      textChannelId: interaction.channelId,
      userId: member.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    })
  } catch (err) {
    await interaction.editReply(`❌ ${(err as Error).message}`)
    return
  }

  ctx.spawnFor(session)
  void ctx.sessions.touch(session.id)
  await interaction.editReply(
    `🎤 Joined **${voiceChannel.name}** — bound to session **${session.name}**. Speak and your transcripts will route through this text channel.`,
  )
}

export async function handleVoiceLeave(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  if (!ctx.voice) {
    await interaction.editReply('🔇 Voice is unavailable — nothing to leave.')
    return
  }
  if (!interaction.guildId) {
    await interaction.editReply('Not in a guild.')
    return
  }
  const left = ctx.voice.leave(interaction.guildId)
  await interaction.editReply(
    left
      ? '👋 Left the voice channel. The claude session is preserved — text messages still work.'
      : 'No active voice line in this guild.',
  )
}

export async function handleSay(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  if (!ctx.voice) {
    await interaction.editReply('🔇 Voice is unavailable.')
    return
  }
  if (!interaction.guildId) {
    await interaction.editReply('Not in a guild.')
    return
  }
  const line = ctx.voice.get(interaction.guildId)
  if (!line) {
    await interaction.editReply('No active voice line. Run `/voice-join` first.')
    return
  }
  const text = interaction.options.getString('text', true)
  await interaction.editReply(`🗣️ Synthesizing: "${text.slice(0, 200)}"`)
  const ok = await ctx.voice.speak(interaction.guildId, text)
  await interaction.followUp({
    content: ok ? '✅ Done.' : '❌ TTS failed (check dispatcher logs).',
    flags: MessageFlags.Ephemeral,
  })
}

// ---------------------------------------------------------------------------
// /resume name:<name> — channel-scoped session switcher. Mirrors the CLI's
// `claude --resume <name>` ergonomics: create-or-attach a named session for
// this channel, killing whatever child was previously bound here. Requires
// the channel to already be /bind'd (admin trust gate is preserved).
// ---------------------------------------------------------------------------

export async function handleResume(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  if (!interaction.guildId) {
    await interaction.editReply('Not in a guild.')
    return
  }
  if (!ctx.guildConfig.isBound(interaction.guildId, interaction.channelId)) {
    await interaction.editReply("This channel isn't bound. An admin needs to run `/bind` here first.")
    return
  }

  const channelId = interaction.channelId
  // Snapshot the current binding BEFORE we mutate anything — we'll need it
  // for the kill+detach step below.
  const current = ctx.sessions.findLatestForChannel(channelId)

  const name = interaction.options.getString('name', true)
  let target = ctx.sessions.findByName(name)
  let created = false
  if (!target) {
    target = await ctx.sessions.create({ name })
    created = true
  }

  // Refuse if the target is already bound to a different channel — don't
  // silently yank it out from under another channel's flow.
  if (target.channelId && target.channelId !== channelId) {
    await interaction.editReply(
      `Session **${target.name}** is currently bound to <#${target.channelId}>. ` +
      `Run \`/unbind\` there first, or pick another name.`,
    )
    return
  }

  if (current?.id === target.id) {
    await interaction.editReply(`Already on **${target.name}** here. No change.`)
    return
  }

  if (current) {
    ctx.killFor(current.id)
    await ctx.sessions.setChannelId(current.id, undefined)
  }
  await ctx.sessions.setChannelId(target.id, channelId)
  ctx.spawnFor(target)

  const parkedNote = current
    ? ` Previous session **${current.name}** parked — warm child killed; run \`/resume name:${current.name}\` to bring it back (transcript is preserved).`
    : ''
  await interaction.editReply(
    created
      ? `🆕 Started new session **${target.name}** — this channel routes to it now.${parkedNote}`
      : `🔁 Resumed **${target.name}** — this channel routes to it now.${parkedNote}`,
  )
}

// ---------------------------------------------------------------------------
// /compact — port of bot/src/index.ts:handleCompact. Summarises the bound
// session's transcript via a one-shot `claude -p --permission-mode plan`,
// forks to a new session seeded with the handoff, and rebinds the channel.
// ---------------------------------------------------------------------------

export async function handleCompact(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  // Non-ephemeral so the handoff preview lands in the channel for everyone.
  await interaction.deferReply()

  if (!interaction.guildId) {
    await interaction.editReply('Not in a guild.')
    return
  }

  const argName = interaction.options.getString('name') ?? undefined
  let target = argName ? ctx.sessions.findByName(argName) : ctx.sessions.findLatestForChannel(interaction.channelId)
  if (!target) {
    await interaction.editReply(
      argName
        ? `No session named "${argName}". \`/sessions\` to list.`
        : "No session bound to this channel. Pass `name:<session>` or `/bind` here first.",
    )
    return
  }

  let lastEditAt = 0
  const onProgress = async (msg: string): Promise<void> => {
    // Throttle edits — Discord ratelimits editReply at ~5/5s per interaction.
    const now = Date.now()
    if (now - lastEditAt < 1000) return
    lastEditAt = now
    try { await interaction.editReply(msg) } catch { /* ignore */ }
  }

  let result
  try {
    result = await compactSession(
      target,
      {
        sessions: ctx.sessions,
        papercupHome: ctx.papercupHome,
        projectDir: ctx.projectDir,
        killFor: ctx.killFor,
      },
      onProgress,
    )
  } catch (err) {
    await interaction.editReply(`❌ Compact failed: ${(err as Error).message}`)
    return
  }

  const handoffLine = result.handoffPath
    ? `Saved to \`${result.handoffPath}\`.\n`
    : '⚠️ Handoff doc was not persisted to disk (see dispatcher logs).\n'
  const reboundLine = result.rebound
    ? `This channel now routes to **${result.newSession.name}**.\n`
    : `Run \`/bind name:${result.newSession.name}\` to route a channel to it.\n`
  // Read the saved handoff back for the preview if we have it; falls back to
  // the in-memory summaryChars count.
  let preview = ''
  if (result.handoffPath) {
    try {
      const fsp = await import('node:fs/promises')
      const md = await fsp.readFile(result.handoffPath, 'utf8')
      preview = md.length > 600 ? md.slice(0, 600) + '…' : md
    } catch { /* ignore */ }
  }
  const previewBlock = preview ? `\n**Handoff preview:**\n>>> ${preview}` : ''

  await interaction.editReply(
    `✅ Compacted **${result.oldName}** → **${result.newSession.name}**\n` +
    `${result.turns} turns digested → ${result.summaryChars} chars of handoff.\n` +
    handoffLine +
    reboundLine +
    previewBlock,
  )
}
