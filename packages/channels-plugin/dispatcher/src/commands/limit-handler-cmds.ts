/**
 * Slash-command handler for the F2 limit-handler subsystem.
 *
 *   /limit-handler show       [session:<id|name>]
 *   /limit-handler mode       mode:<auto-nudge|ask-user|off> [session:<id|name>]
 *   /limit-handler set-nudge  text:"<text>" [session:<id|name>]
 *   /limit-handler set-grace  seconds:<int> [session:<id|name>]
 *
 * Auth: same ACL gate as /cron — owner manages anything, allowlisted users
 * manage their own sessions only. `ask-user` mode is accepted but documented
 * as deferred (the watcher treats it as `off` until the DM-interaction epic
 * ships).
 */

import { ChatInputCommandInteraction, MessageFlags } from 'discord.js'

import type { CommandContext } from './types.ts'
import type { LimitMode } from '../scheduler/store.ts'

const MAX_NUDGE_LEN = 500
const MIN_GRACE_S = 0
const MAX_GRACE_S = 3600

async function replyEphemeral(
  i: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  if (i.deferred) await i.editReply(content)
  else await i.reply({ content, flags: MessageFlags.Ephemeral })
}

function requireLimit(
  ctx: CommandContext,
): { ok: false; reason: string } | {
  ok: true
  api: NonNullable<CommandContext['schedulerLimit']>
  acl: NonNullable<CommandContext['schedulerAcl']>
} {
  if (!ctx.schedulerLimit || !ctx.schedulerAcl) {
    return { ok: false, reason: 'Scheduler subsystem not initialized.' }
  }
  return { ok: true, api: ctx.schedulerLimit, acl: ctx.schedulerAcl }
}

function resolveSessionId(
  ctx: CommandContext,
  i: ChatInputCommandInteraction,
): { sessionId: string } | { error: string } {
  const explicit = i.options.getString('session') ?? null
  if (explicit) {
    const byName = ctx.sessions.findByName(explicit)
    if (byName) return { sessionId: byName.id }
    const byId = ctx.sessions.findById(explicit)
    if (byId) return { sessionId: byId.id }
    return { error: `No session named or with id matching \`${explicit}\`.` }
  }
  if (!i.channelId) return { error: 'No channel context.' }
  const bound = ctx.sessions.findLatestForChannel(i.channelId)
  if (!bound) {
    return { error: 'No session bound to this channel. Pass `session:<name>` or `/bind` first.' }
  }
  return { sessionId: bound.id }
}

export async function handleLimitHandler(
  i: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral })
  const got = requireLimit(ctx)
  if (!got.ok) { await replyEphemeral(i, got.reason); return }
  const { api, acl } = got

  const sub = i.options.getSubcommand(true)
  const actor = i.user.id
  const sessRes = resolveSessionId(ctx, i)
  if ('error' in sessRes) { await replyEphemeral(i, sessRes.error); return }
  const sessionId = sessRes.sessionId

  if (!acl.canManage(actor, null)) {
    await replyEphemeral(i, '❌ Not authorized (owner or allowlist only).')
    return
  }

  if (sub === 'show') {
    const cfg = api.show(sessionId)
    const lines = [
      `**limit-handler** for session \`${sessionId.slice(0, 8)}\``,
      `• mode:  \`${cfg.mode}\``,
      `• grace: ${(cfg.graceMs / 1000).toFixed(0)}s`,
      `• nudge: "${cfg.nudgeText ?? ''}"`,
    ]
    if (cfg.updatedAtEpochMs > 0) {
      lines.push(`• updated: ${new Date(cfg.updatedAtEpochMs).toISOString()}`)
    } else {
      lines.push('• (defaults — never customized)')
    }
    await replyEphemeral(i, lines.join('\n'))
    return
  }

  if (sub === 'mode') {
    const mode = i.options.getString('mode', true) as LimitMode
    if (mode !== 'auto-nudge' && mode !== 'ask-user' && mode !== 'off') {
      await replyEphemeral(i, `❌ Invalid mode \`${mode}\`. Use auto-nudge | ask-user | off.`)
      return
    }
    const cfg = api.setMode(sessionId, mode)
    const note = mode === 'ask-user'
      ? ' ⚠️ ask-user mode is deferred; watcher will treat it as off until the DM-interaction epic ships.'
      : ''
    await replyEphemeral(i, `✅ mode set to \`${cfg.mode}\`.${note}`)
    return
  }

  if (sub === 'set-nudge') {
    const text = i.options.getString('text', true)
    if (text.length === 0 || text.length > MAX_NUDGE_LEN) {
      await replyEphemeral(i, `❌ Nudge text must be 1..${MAX_NUDGE_LEN} chars.`)
      return
    }
    const cfg = api.setNudge(sessionId, text)
    await replyEphemeral(i, `✅ nudge text set: "${cfg.nudgeText}"`)
    return
  }

  if (sub === 'set-grace') {
    const seconds = i.options.getInteger('seconds', true)
    if (!Number.isInteger(seconds) || seconds < MIN_GRACE_S || seconds > MAX_GRACE_S) {
      await replyEphemeral(i, `❌ Grace must be ${MIN_GRACE_S}..${MAX_GRACE_S} seconds.`)
      return
    }
    const cfg = api.setGraceMs(sessionId, seconds * 1000)
    await replyEphemeral(i, `✅ grace set to ${cfg.graceMs / 1000}s.`)
    return
  }

  await replyEphemeral(i, `❌ Unknown /limit-handler subcommand: ${sub}`)
}
