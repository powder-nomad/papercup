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
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js'
import type { CommandContext } from './types.ts'
import type { SessionEffort, SessionTransportName } from '../state/sessions.ts'
import { compactSession } from '../compact.ts'
import { listByBackend, KNOWN_BACKENDS } from '../state/model-catalog.ts'
import { t } from '../i18n.ts'

/**
 * Voice-mode defaults — applied by /pickup when the operator omits a flag.
 * Override per-deployment via env. Hardcoded fallbacks bias toward "fast
 * conversational" (gemini-flash + per-turn + minimal effort) because round-
 * trip latency matters more than reasoning depth in voice.
 */
const VOICE_DEFAULT_BACKEND = process.env.PAPERCUP_VOICE_DEFAULT_BACKEND ?? 'gemini-cli'
const VOICE_DEFAULT_MODEL = process.env.PAPERCUP_VOICE_DEFAULT_MODEL ?? 'gemini-2.5-flash'
const VOICE_DEFAULT_TRANSPORT = (process.env.PAPERCUP_VOICE_DEFAULT_TRANSPORT ?? 'per-turn') as SessionTransportName
const VOICE_DEFAULT_EFFORT = process.env.PAPERCUP_VOICE_DEFAULT_EFFORT as SessionEffort | undefined

export async function handleBind(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  if (!interaction.guildId || !interaction.guild) {
    await interaction.editReply(t(interaction.locale, 'common.notInGuild'))
    return
  }
  const member = interaction.member
  if (!(member instanceof GuildMember) || !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.editReply(t(interaction.locale, 'common.permManageGuildBind'))
    return
  }

  const channelId = interaction.channelId
  const nameOpt = interaction.options.getString('name') ?? undefined
  const transportOpt = (interaction.options.getString('transport') ?? undefined) as
    | SessionTransportName
    | undefined
  const backendOpt = interaction.options.getString('backend') ?? undefined

  // Channels transport is claude-code-only — reject mismatched combinations
  // at bind time so the user gets a clear error instead of a silent no-op.
  if (transportOpt === 'channels' && backendOpt && backendOpt !== 'claude-code') {
    await interaction.editReply(t(interaction.locale, 'bind.channelsClaudeOnly', { backend: backendOpt }))
    return
  }
  // Channels transport needs tmux to give claude a TTY. Refuse loudly here
  // rather than silently downgrading — the operator picked transport:channels
  // for a reason and should hear that the host can't honor it.
  if (transportOpt === 'channels' && !ctx.channelsAvailable()) {
    await interaction.editReply(t(interaction.locale, 'bind.channelsNeedsTmux'))
    return
  }

  // If a name was given, look it up. Otherwise, prefer reattaching the
  // existing session on this channel (so /bind is also "reactivate").
  // When a name is given and no such session exists, create it on the
  // spot — /bind + /rename is a common two-step that's worth collapsing.
  let target = nameOpt ? ctx.sessions.findByName(nameOpt) : ctx.sessions.findLatestForChannel(channelId)
  if (!target) {
    // Auto-pick per-turn for non-claude backends if transport not specified.
    const effectiveTransport: SessionTransportName | undefined =
      transportOpt ?? (backendOpt && backendOpt !== 'claude-code' ? 'per-turn' : undefined)
    target = await ctx.sessions.create({
      name: nameOpt,
      channelId,
      transport: effectiveTransport,
      backend: backendOpt,
    })
  } else {
    // Existing session — apply any requested overrides, killing the child
    // so the next message respawns under the new config.
    let mutated = false
    if (transportOpt && transportOpt !== target.transport) {
      ctx.killFor(target.id)
      const u = await ctx.sessions.setTransport(target.id, transportOpt)
      if (u) { target = u; mutated = true }
    }
    if (backendOpt && backendOpt !== target.backend) {
      if (!mutated) ctx.killFor(target.id)
      const u = await ctx.sessions.setBackend(target.id, backendOpt)
      if (u) { target = u }
    }
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
    `[bind] guild ${interaction.guildId} channel ${channelId} → session "${target.name}" (transport=${target.transport} backend=${target.backend}) by ${member.user.tag}`,
  )
  await interaction.editReply(t(interaction.locale, 'bind.success', {
    name: target.name,
    transport: target.transport,
    backend: target.backend,
  }))
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
    await interaction.editReply(t(interaction.locale, 'common.notInGuild'))
    return
  }
  const member = interaction.member
  if (!(member instanceof GuildMember) || !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.editReply(t(interaction.locale, 'common.permManageGuildTransport'))
    return
  }

  const target = ctx.sessions.findLatestForChannel(interaction.channelId)
  if (!target) {
    await interaction.editReply(t(interaction.locale, 'common.noSessionHere'))
    return
  }

  const mode = interaction.options.getString('mode', true) as SessionTransportName
  if (mode === target.transport) {
    await interaction.editReply(t(interaction.locale, 'transport.alreadyOnMode', { name: target.name, mode }))
    return
  }
  if (mode === 'channels' && !ctx.channelsAvailable()) {
    await interaction.editReply(t(interaction.locale, 'bind.channelsNeedsTmux'))
    return
  }

  ctx.killFor(target.id)
  const updated = await ctx.sessions.setTransport(target.id, mode)
  if (!updated) {
    await interaction.editReply(t(interaction.locale, 'common.sessionVanished'))
    return
  }
  const note = mode === 'per-turn' ? t(interaction.locale, 'transport.perTurnNote') : ''
  await interaction.editReply(t(interaction.locale, 'transport.set', { mode, note }))
}

/**
 * /backend name:<…> — switch the bound session's underlying CLI driver.
 * Channels-transport sessions are pinned to claude-code; this command will
 * reject anything else for them (caller should /transport mode:per-turn first).
 */
export async function handleBackend(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  if (!interaction.guildId) {
    await interaction.editReply(t(interaction.locale, 'common.notInGuild'))
    return
  }
  const member = interaction.member
  if (!(member instanceof GuildMember) || !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.editReply(t(interaction.locale, 'common.permManageGuildBackend'))
    return
  }

  const target = ctx.sessions.findLatestForChannel(interaction.channelId)
  if (!target) {
    await interaction.editReply(t(interaction.locale, 'common.noSessionHere'))
    return
  }

  const name = interaction.options.getString('name', true)
  if (name === target.backend) {
    await interaction.editReply(t(interaction.locale, 'backend.alreadyOnName', { name: target.name, backend: name }))
    return
  }
  if (target.transport === 'channels' && name !== 'claude-code') {
    await interaction.editReply(t(interaction.locale, 'backend.channelsClaudeOnly', { backend: name }))
    return
  }

  ctx.killFor(target.id)
  const updated = await ctx.sessions.setBackend(target.id, name)
  if (!updated) {
    await interaction.editReply(t(interaction.locale, 'common.sessionVanished'))
    return
  }
  await interaction.editReply(t(interaction.locale, 'backend.set', { backend: name }))
}

export async function handleUnbind(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  if (!interaction.guildId || !interaction.guild) {
    await interaction.editReply(t(interaction.locale, 'common.notInGuild'))
    return
  }
  const member = interaction.member
  if (!(member instanceof GuildMember) || !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.editReply(t(interaction.locale, 'common.permManageGuildUnbind'))
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
  await interaction.editReply(t(interaction.locale, wasBound ? 'unbind.success' : 'unbind.wasNotBound'))
}

export async function handleSessions(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const list = ctx.sessions.list().slice(0, 15)
  if (list.length === 0) {
    await interaction.editReply(t(interaction.locale, 'sessions.empty'))
    return
  }
  const rows = list.map(s => {
    const channel = s.channelId ? ` <#${s.channelId}>` : ''
    const idleMin = Math.floor((Date.now() - s.lastActiveAt) / 60_000)
    const status = ctx.isPluginOnline(s.id) ? '🟢' : '⚪'
    const extras = [
      `transport=${s.transport}`,
      `backend=${s.backend}`,
      s.model && `model=${s.model}`,
      s.effort && `effort=${s.effort}`,
      s.permissionMode && `perm=${s.permissionMode}`,
    ].filter(Boolean).join(' ')
    return `${status} **${s.name}**${channel} — idle ${idleMin}m${extras ? `  ·  ${extras}` : ''}`
  })
  await interaction.editReply(rows.join('\n'))
}

export async function handleStatus(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  const target = ctx.sessions.findLatestForChannel(interaction.channelId)
  if (!target) {
    await interaction.editReply(t(interaction.locale, 'status.noSession'))
    return
  }
  const online = ctx.isPluginOnline(target.id)
  const lines: string[] = []
  lines.push(
    t(interaction.locale, 'status.header', {
      name: target.name,
      transport: target.transport,
      backend: target.backend,
      dot: '·',
      pluginState: t(interaction.locale, online ? 'status.pluginOnline' : 'status.pluginOffline'),
    }),
  )
  lines.push(t(interaction.locale, 'status.lineModel', { value: target.model ?? '(backend default)' }))
  if (target.effort) {
    lines.push(t(interaction.locale, 'status.lineEffort', { value: target.effort }))
  }
  if (target.permissionMode) {
    lines.push(t(interaction.locale, 'status.linePermissions', { value: target.permissionMode }))
  } else {
    const defaultPerm = target.transport === 'channels' ? 'bypassPermissions' : 'default'
    lines.push(t(interaction.locale, 'status.linePermissionsDefault', { value: defaultPerm }))
  }
  if (target.channelId) {
    lines.push(t(interaction.locale, 'status.lineChannel', { channelId: target.channelId }))
  } else {
    lines.push(t(interaction.locale, 'status.lineChannelNone'))
  }
  const idleMin = Math.floor((Date.now() - target.lastActiveAt) / 60_000)
  lines.push(t(interaction.locale, 'status.lineIdle', { minutes: idleMin }))
  await interaction.editReply(lines.join('\n'))
}

/**
 * /respawn — kill the agent child (if alive) and spawn a fresh one for this
 * channel's bound session. Useful when /status shows "plugin offline" and
 * the operator wants to revive without sending a fake user message.
 */
export async function handleRespawn(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  const target = ctx.sessions.findLatestForChannel(interaction.channelId)
  if (!target) {
    await interaction.editReply(t(interaction.locale, 'common.noSessionHere'))
    return
  }
  const wasOnline = ctx.isPluginOnline(target.id)
  if (wasOnline) ctx.killFor(target.id)
  ctx.spawnFor(target)
  await interaction.editReply(
    t(interaction.locale, wasOnline ? 'respawn.killedAndRespawned' : 'respawn.spawned', {
      name: target.name,
    }),
  )
}

export async function handleRename(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const channelId = interaction.channelId
  const target = ctx.sessions.findLatestForChannel(channelId)
  if (!target) {
    await interaction.editReply(t(interaction.locale, 'common.noSessionHere'))
    return
  }

  const newName = interaction.options.getString('name', true)
  try {
    const updated = await ctx.sessions.rename(target.id, newName)
    await interaction.editReply(t(interaction.locale, 'rename.success', { name: updated.name }))
  } catch (err) {
    await interaction.editReply(t(interaction.locale, 'common.errorPrefix', { error: (err as Error).message }))
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
    await interaction.editReply(t(interaction.locale, 'common.noSessionHere'))
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
    await interaction.editReply(t(interaction.locale, 'common.sessionVanished'))
    return
  }
  ctx.killFor(updated.id)
  await interaction.editReply(
    name
      ? t(interaction.locale, 'model.set', { model: updated.model ?? '' })
      : t(interaction.locale, 'model.cleared'),
  )
}

/**
 * /models [backend:<name>] — discovery helper. Lists curated model ids
 * known to be accepted by a backend. Without `backend:`, defaults to this
 * channel's bound session's backend. Backends with no curated entries
 * (aider, opencode, crush, amp) get a hint to pass whatever the CLI accepts.
 */
export async function handleModels(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  let backend = interaction.options.getString('backend') ?? undefined
  if (!backend) {
    const target = ctx.sessions.findLatestForChannel(interaction.channelId)
    if (!target) {
      await interaction.editReply(t(interaction.locale, 'models.noSessionPickBackend'))
      return
    }
    backend = target.backend
  }

  const models = listByBackend(backend)
  if (models.length === 0) {
    const hint = KNOWN_BACKENDS.has(backend)
      ? t(interaction.locale, 'models.noCuratedForKnown')
      : t(interaction.locale, 'models.noCuratedForUnknown', { backend })
    await interaction.editReply(t(interaction.locale, 'models.headerForBackend', { backend, hint }))
    return
  }

  // Group by family for readability when there are many entries (≥6).
  const lines: string[] = [t(interaction.locale, 'models.headerKnown', { backend })]
  for (const m of models) {
    const note = m.notes ? `  _(${m.notes})_` : ''
    lines.push(`• \`${m.id}\`  · ${m.provider}/${m.family}${note}`)
  }
  lines.push('')
  lines.push(t(interaction.locale, 'models.applyFooter'))
  await interaction.editReply(lines.join('\n'))
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
    await interaction.editReply(t(interaction.locale, 'common.sessionVanished'))
    return
  }
  ctx.killFor(updated.id)
  await interaction.editReply(
    effort
      ? t(interaction.locale, 'effort.set', { effort })
      : t(interaction.locale, 'effort.cleared'),
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
  // Plan mode opens an interactive "Approve plan? [y/N]" prompt at the
  // claude TTY. Channels-transport claude runs inside a detached tmux
  // session with no human at the keyboard, so plan mode would hang the
  // turn indefinitely. AskUserQuestion is blocked at spawn (--disallowedTools);
  // plan mode is gated here at the command layer so the user gets a clear
  // error instead of a silent hang.
  if (mode === 'plan' && target.transport === 'channels') {
    await interaction.editReply(t(interaction.locale, 'permissions.planChannelsUnsupported'))
    return
  }
  const value = mode === 'default-for-mode'
    ? undefined
    : (mode as NonNullable<typeof target.permissionMode>)
  const updated = await ctx.sessions.setPermissionMode(target.id, value)
  if (!updated) {
    await interaction.editReply(t(interaction.locale, 'common.sessionVanished'))
    return
  }
  ctx.killFor(updated.id)
  await interaction.editReply(
    value
      ? t(interaction.locale, 'permissions.set', { mode: value })
      : t(interaction.locale, 'permissions.cleared'),
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
      ? t(interaction.locale, 'cancel.aborted', { name: target.name })
      : t(interaction.locale, 'cancel.nothing', { name: target.name }),
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
    await interaction.editReply(t(interaction.locale, 'voice.unavailable'))
    return
  }
  if (!interaction.guild || !interaction.guildId) {
    await interaction.editReply(t(interaction.locale, 'common.notInGuild'))
    return
  }
  const member = interaction.member
  if (!(member instanceof GuildMember)) {
    await interaction.editReply(t(interaction.locale, 'common.couldntResolveMember'))
    return
  }
  const voiceChannel = member.voice.channel
  if (!voiceChannel) {
    await interaction.editReply(t(interaction.locale, 'voiceJoin.needVoiceChannelFirst'))
    return
  }
  const session = ctx.sessions.findLatestForChannel(interaction.channelId)
  if (!session) {
    await interaction.editReply(t(interaction.locale, 'voiceJoin.channelNotBound'))
    return
  }
  if (ctx.voice.has(interaction.guildId)) {
    await interaction.editReply(t(interaction.locale, 'voiceJoin.alreadyOnLine'))
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
    await interaction.editReply(t(interaction.locale, 'common.errorPrefix', { error: (err as Error).message }))
    return
  }

  ctx.spawnFor(session)
  void ctx.sessions.touch(session.id)
  await interaction.editReply(t(interaction.locale, 'voiceJoin.success', {
    channel: voiceChannel.name,
    name: session.name,
  }))
}

export async function handleVoiceLeave(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  if (!ctx.voice) {
    await interaction.editReply(t(interaction.locale, 'voice.unavailableNothingToLeave'))
    return
  }
  if (!interaction.guildId) {
    await interaction.editReply(t(interaction.locale, 'common.notInGuild'))
    return
  }
  const left = ctx.voice.leave(interaction.guildId)
  await interaction.editReply(t(interaction.locale, left ? 'voiceLeave.left' : 'voiceLeave.notOnLine'))
}

export async function handleSay(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  if (!ctx.voice) {
    await interaction.editReply(t(interaction.locale, 'voice.unavailableShort'))
    return
  }
  if (!interaction.guildId) {
    await interaction.editReply(t(interaction.locale, 'common.notInGuild'))
    return
  }
  const line = ctx.voice.get(interaction.guildId)
  if (!line) {
    await interaction.editReply(t(interaction.locale, 'say.noActiveLine'))
    return
  }
  const text = interaction.options.getString('text', true)
  await interaction.editReply(t(interaction.locale, 'say.synthesizing', { preview: text.slice(0, 200) }))
  const ok = await ctx.voice.speak(interaction.guildId, text)
  await interaction.followUp({
    content: t(interaction.locale, ok ? 'say.done' : 'say.ttsFailed'),
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
    await interaction.editReply(t(interaction.locale, 'common.notInGuild'))
    return
  }
  if (!ctx.guildConfig.isBound(interaction.guildId, interaction.channelId)) {
    await interaction.editReply(t(interaction.locale, 'resume.channelNotBound'))
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
    await interaction.editReply(t(interaction.locale, 'resume.targetBoundElsewhere', {
      name: target.name,
      channelId: target.channelId,
    }))
    return
  }

  if (current?.id === target.id) {
    await interaction.editReply(t(interaction.locale, 'resume.sameAsCurrent', { name: target.name }))
    return
  }

  if (current) {
    ctx.killFor(current.id)
    await ctx.sessions.setChannelId(current.id, undefined)
  }
  await ctx.sessions.setChannelId(target.id, channelId)
  ctx.spawnFor(target)

  const parkedNote = current
    ? t(interaction.locale, 'resume.parkedNote', { name: current.name })
    : ''
  await interaction.editReply(t(interaction.locale, created ? 'resume.createdNew' : 'resume.switchedTo', {
    name: target.name,
    parked: parkedNote,
  }))
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
    await interaction.editReply(t(interaction.locale, 'common.notInGuild'))
    return
  }

  const argName = interaction.options.getString('name') ?? undefined
  let target = argName ? ctx.sessions.findByName(argName) : ctx.sessions.findLatestForChannel(interaction.channelId)
  if (!target) {
    await interaction.editReply(
      argName
        ? t(interaction.locale, 'compact.targetNotFoundNamed', { name: argName })
        : t(interaction.locale, 'compact.targetNotFound'),
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
    await interaction.editReply(t(interaction.locale, 'compact.failed', { error: (err as Error).message }))
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

/**
 * Discord-side autocomplete for any slash-command string option that wants
 * backend-aware model suggestions. Fires per keystroke (Discord debounces);
 * must respond within 3s. Returns ≤25 suggestions matching the user's
 * partial input. Looks up the relevant backend from:
 *   1. The interaction's own `backend:` option (for /pickup)
 *   2. The bound session's backend (for /model)
 *   3. The voice default (for /pickup if no session and no backend chosen yet)
 *
 * Backends without curated entries (aider, opencode, …) return empty —
 * Discord shows nothing, user types freely. /model name:<anything> still
 * passes through to the underlying CLI.
 */
export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  ctx: CommandContext,
): Promise<void> {
  try {
    const focused = interaction.options.getFocused(true)
    if (focused.name !== 'name' && focused.name !== 'model') {
      await interaction.respond([])
      return
    }
    let backend: string | undefined = interaction.options.getString('backend') ?? undefined
    if (!backend) {
      backend = ctx.sessions.findLatestForChannel(interaction.channelId)?.backend
    }
    if (!backend && interaction.commandName === 'pickup') {
      backend = VOICE_DEFAULT_BACKEND
    }
    if (!backend) {
      await interaction.respond([])
      return
    }
    const partial = String(focused.value).toLowerCase()
    const choices = listByBackend(backend)
      .filter(m => !partial || m.id.toLowerCase().includes(partial))
      .slice(0, 25)
      .map(m => ({ name: `${m.id} · ${m.provider}/${m.family}`, value: m.id }))
    await interaction.respond(choices)
  } catch (err) {
    // Autocomplete failures must never throw — Discord just shows no
    // suggestions and the user types freely.
    console.error('[commands] autocomplete error:', err)
    try { await interaction.respond([]) } catch { /* ignore */ }
  }
}

/**
 * /pickup — voice-first one-step combining /bind + /voice-join.
 *
 * Resolves or creates a session for the current text channel, applies any
 * config args (or voice-mode defaults via PAPERCUP_VOICE_DEFAULT_*), and
 * joins the user's voice channel. Mirrors the legacy bot's /pickup flow:
 * user sits in a voice channel, calls /pickup in a text channel, bot
 * answers. The text channel becomes the session's home channel too — text
 * messages there continue routing to the same session even after /hangup.
 */
export async function handlePickup(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  if (!ctx.voice) {
    await interaction.editReply(t(interaction.locale, 'voice.unavailable'))
    return
  }
  if (!interaction.guild || !interaction.guildId) {
    await interaction.editReply(t(interaction.locale, 'common.notInGuild'))
    return
  }
  const member = interaction.member
  if (!(member instanceof GuildMember)) {
    await interaction.editReply(t(interaction.locale, 'common.couldntResolveMember'))
    return
  }
  const voiceChannel = member.voice.channel
  if (!voiceChannel) {
    await interaction.editReply(t(interaction.locale, 'pickup.needVoiceChannelFirst'))
    return
  }
  if (ctx.voice.has(interaction.guildId)) {
    await interaction.editReply(t(interaction.locale, 'pickup.alreadyOnLine'))
    return
  }

  // Pull args + apply defaults.
  const transport = (interaction.options.getString('transport') ?? VOICE_DEFAULT_TRANSPORT) as SessionTransportName
  const backend = interaction.options.getString('backend') ?? VOICE_DEFAULT_BACKEND
  const model = interaction.options.getString('model') ?? VOICE_DEFAULT_MODEL
  const effort = (interaction.options.getString('effort') ?? VOICE_DEFAULT_EFFORT) as SessionEffort | undefined

  // Reject channels+non-claude up front (matches /bind validation).
  if (transport === 'channels' && backend !== 'claude-code') {
    await interaction.editReply(t(interaction.locale, 'bind.channelsClaudeOnly', { backend }))
    return
  }
  if (transport === 'channels' && !ctx.channelsAvailable()) {
    await interaction.editReply(t(interaction.locale, 'bind.channelsNeedsTmux'))
    return
  }

  // Resolve-or-create the session for this text channel.
  const channelId = interaction.channelId
  let session = ctx.sessions.findLatestForChannel(channelId)
  if (!session) {
    session = await ctx.sessions.create({ channelId, transport, backend })
  } else {
    // Apply requested overrides to an existing session — same logic as /bind.
    if (transport !== session.transport) {
      ctx.killFor(session.id)
      const u = await ctx.sessions.setTransport(session.id, transport)
      if (u) session = u
    }
    if (backend !== session.backend) {
      ctx.killFor(session.id)
      const u = await ctx.sessions.setBackend(session.id, backend)
      if (u) session = u
    }
  }

  // Model/effort overrides (always apply if specified — these don't require
  // child kill since they take effect on next respawn).
  if (model && session.model !== model) {
    const u = await ctx.sessions.setModel(session.id, model)
    if (u) session = u
  }
  if (effort !== undefined && session.effort !== effort) {
    const u = await ctx.sessions.setEffort(session.id, effort)
    if (u) session = u
  }

  // Persist the channel binding so subsequent text messages here route to
  // the same session (and the guild-config knows this channel is bot-served).
  await ctx.sessions.setChannelId(session.id, channelId)
  await ctx.guildConfig.addBoundChannel(interaction.guildId, channelId)

  // Join the voice channel.
  try {
    await ctx.voice.join({
      sessionId: session.id,
      guildId: interaction.guildId,
      voiceChannelId: voiceChannel.id,
      textChannelId: channelId,
      userId: member.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    })
  } catch (err) {
    await interaction.editReply(t(interaction.locale, 'common.errorPrefix', { error: (err as Error).message }))
    return
  }

  ctx.spawnFor(session)
  void ctx.sessions.touch(session.id)
  console.log(
    `[pickup] guild ${interaction.guildId} voice=${voiceChannel.name} text=${channelId} ` +
    `→ session "${session.name}" (transport=${session.transport} backend=${session.backend} ` +
    `model=${session.model ?? '(default)'} effort=${session.effort ?? '(default)'}) by ${member.user.tag}`,
  )
  await interaction.editReply(t(interaction.locale, 'pickup.success', {
    channel: voiceChannel.name,
    name: session.name,
    transport: session.transport,
    backend: session.backend,
    model: session.model ?? '(default)',
    effort: session.effort ?? '(default)',
  }))
}

/**
 * /hangup — alias for /voice-leave. Bot disconnects from voice but the
 * text-channel binding (and the session) are preserved. Symmetry with
 * /pickup makes the phone-call mental model legible.
 */
export async function handleHangup(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await handleVoiceLeave(interaction, ctx)
}
