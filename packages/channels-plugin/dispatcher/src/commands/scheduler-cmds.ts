/**
 * Slash-command handlers for the scheduler subsystem:
 *
 *   /schedule  add | list | delete | edit
 *   /queue     add | list | delete
 *   /scheduler allow | deny | allowlist
 *
 * Auth: F1 ships in bot-owner-only mode. ACL.canManage is the gate; failures
 * land as ephemeral "Not authorized" replies. The acl honors an allowlist
 * row-by-row (DESIGN-scheduler.md §Auth), so phase 1.5 will flip on by
 * inserting via /scheduler allow without code change.
 *
 * Time display: every reply renders TZ via `formatTimezoneLabel`, e.g.
 *   "next fire: 2026-05-28T09:00 KST(UTC+9)"
 * The IANA name (`Asia/Seoul`) is stored but never shown.
 */

import { ChatInputCommandInteraction, MessageFlags } from 'discord.js'

import type { CommandContext } from './types.ts'
import type { Job, JobKind } from '../scheduler/index.ts'
import { hostTimezone, formatTimezoneLabel, parseAtTime, isParseError } from '../scheduler/parser.ts'

const PROMPT_PREVIEW_LEN = 40
const MAX_LIST_ROWS = 20

async function replyEphemeral(
  i: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  if (i.deferred) await i.editReply(content)
  else await i.reply({ content, flags: MessageFlags.Ephemeral })
}

function requireScheduler(
  ctx: CommandContext,
): { ok: false; reason: string } | {
  ok: true
  scheduler: NonNullable<CommandContext['scheduler']>
  acl: NonNullable<CommandContext['schedulerAcl']>
} {
  if (!ctx.scheduler || !ctx.schedulerAcl) {
    return { ok: false, reason: 'Scheduler subsystem not initialized.' }
  }
  return { ok: true, scheduler: ctx.scheduler, acl: ctx.schedulerAcl }
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

function previewPrompt(text: string): string {
  if (text.length <= PROMPT_PREVIEW_LEN) return text
  return text.slice(0, PROMPT_PREVIEW_LEN - 1).trimEnd() + '…'
}

function formatJobLine(job: Job): string {
  const id = shortId(job.id)
  const status = job.enabled ? '' : ' (disabled)'
  const prompt = previewPrompt(job.prompt)
  const tz = job.tz ?? hostTimezone()
  const tzLabel = formatTimezoneLabel(tz, job.nextFireAtEpochMs)
  const next = new Date(job.nextFireAtEpochMs).toISOString()
  if (job.kind === 'cron') {
    return `\`${id}\` cron \`${job.cronExpr}\` (${tzLabel}) — next ${next} — "${prompt}"${status}`
  }
  return `\`${id}\` ${job.kind} — fires ${next} (${tzLabel}) — "${prompt}"${status}`
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

/* ---------------------------- /schedule ------------------------------- */

export async function handleSchedule(
  i: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral })
  const got = requireScheduler(ctx)
  if (!got.ok) { await replyEphemeral(i, got.reason); return }
  const { scheduler, acl } = got

  const sub = i.options.getSubcommand(true)
  const actor = i.user.id

  if (sub === 'add') {
    if (!acl.canManage(actor, null)) { await replyEphemeral(i, '❌ Not authorized (owner or allowlist only).'); return }
    const sessRes = resolveSessionId(ctx, i)
    if ('error' in sessRes) { await replyEphemeral(i, sessRes.error); return }
    const expr = i.options.getString('frequency', true)
    const prompt = i.options.getString('prompt', true)
    try {
      const job = scheduler.addCron({
        sessionId: sessRes.sessionId,
        ownerId: actor,
        prompt,
        cronExpr: expr,
      })
      const tzLabel = formatTimezoneLabel(job.tz ?? hostTimezone(), job.nextFireAtEpochMs)
      const next = new Date(job.nextFireAtEpochMs).toISOString()
      await replyEphemeral(i, `✅ Schedule registered \`${shortId(job.id)}\`: \`${expr}\` (${tzLabel}). Next fire: ${next}.`)
    } catch (err) {
      await replyEphemeral(i, `❌ ${(err as Error).message}`)
    }
    return
  }

  if (sub === 'list') {
    if (!acl.isOwner(actor) && !acl.isAllowlisted(actor)) {
      await replyEphemeral(i, '❌ Not authorized.')
      return
    }
    const sessOpt = i.options.getString('session') ?? null
    const filter: { kind: JobKind; sessionId?: string; ownerId?: string } = { kind: 'cron' }
    if (sessOpt) {
      const sessRes = resolveSessionId(ctx, i)
      if ('error' in sessRes) { await replyEphemeral(i, sessRes.error); return }
      filter.sessionId = sessRes.sessionId
    }
    if (!acl.isOwner(actor)) filter.ownerId = actor
    const rows = scheduler.listJobs(filter).slice(0, MAX_LIST_ROWS)
    if (rows.length === 0) { await replyEphemeral(i, 'No scheduled jobs.'); return }
    await replyEphemeral(i, rows.map(formatJobLine).join('\n'))
    return
  }

  if (sub === 'delete') {
    const idArg = i.options.getString('id', true)
    const target = scheduler.getJob(idArg)
    if (!target) { await replyEphemeral(i, `❌ No job matching id \`${idArg}\`.`); return }
    if (!acl.canManage(actor, target.ownerId)) { await replyEphemeral(i, '❌ Not authorized to delete this job.'); return }
    scheduler.deleteJob(target.id)
    await replyEphemeral(i, `🗑️ Deleted job \`${shortId(target.id)}\`.`)
    return
  }

  if (sub === 'edit') {
    const idArg = i.options.getString('id', true)
    const target = scheduler.getJob(idArg)
    if (!target) { await replyEphemeral(i, `❌ No job matching id \`${idArg}\`.`); return }
    if (!acl.canManage(actor, target.ownerId)) { await replyEphemeral(i, '❌ Not authorized.'); return }
    const enabledOpt = i.options.getBoolean('enabled')
    if (enabledOpt === null) {
      await replyEphemeral(i, 'ℹ️ Pass `enabled:true|false` to toggle. Other edits → delete + re-add.')
      return
    }
    scheduler.setEnabled(target.id, enabledOpt)
    await replyEphemeral(i, `✏️ Job \`${shortId(target.id)}\` enabled=${enabledOpt}.`)
    return
  }

  await replyEphemeral(i, `❌ Unknown /schedule subcommand: ${sub}`)
}

/* ------------------------------ /queue -------------------------------- */

export async function handleQueue(
  i: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral })
  const got = requireScheduler(ctx)
  if (!got.ok) { await replyEphemeral(i, got.reason); return }
  const { scheduler, acl } = got

  const sub = i.options.getSubcommand(true)
  const actor = i.user.id

  if (sub === 'add') {
    if (!acl.canManage(actor, null)) { await replyEphemeral(i, '❌ Not authorized.'); return }
    const sessRes = resolveSessionId(ctx, i)
    if ('error' in sessRes) { await replyEphemeral(i, sessRes.error); return }
    const atSpec = i.options.getString('at', true)
    const prompt = i.options.getString('prompt', true)
    const tz = hostTimezone()
    const parsed = parseAtTime(atSpec, tz, Date.now())
    if (isParseError(parsed)) { await replyEphemeral(i, `❌ ${parsed.error}`); return }
    try {
      const job = scheduler.addQueue({
        sessionId: sessRes.sessionId,
        ownerId: actor,
        prompt,
        fireAtEpochMs: parsed,
      })
      const tzLabel = formatTimezoneLabel(tz, parsed)
      const when = new Date(parsed).toISOString()
      await replyEphemeral(i, `✅ Queue registered \`${shortId(job.id)}\` — fires ${when} (${tzLabel}).`)
    } catch (err) {
      await replyEphemeral(i, `❌ ${(err as Error).message}`)
    }
    return
  }

  if (sub === 'list') {
    if (!acl.isOwner(actor) && !acl.isAllowlisted(actor)) {
      await replyEphemeral(i, '❌ Not authorized.')
      return
    }
    const sessOpt = i.options.getString('session') ?? null
    const filter: { kind: JobKind; sessionId?: string; ownerId?: string } = { kind: 'queue' }
    if (sessOpt) {
      const sessRes = resolveSessionId(ctx, i)
      if ('error' in sessRes) { await replyEphemeral(i, sessRes.error); return }
      filter.sessionId = sessRes.sessionId
    }
    if (!acl.isOwner(actor)) filter.ownerId = actor
    const rows = scheduler.listJobs(filter).slice(0, MAX_LIST_ROWS)
    if (rows.length === 0) { await replyEphemeral(i, 'No queued jobs.'); return }
    await replyEphemeral(i, rows.map(formatJobLine).join('\n'))
    return
  }

  if (sub === 'delete') {
    const idArg = i.options.getString('id', true)
    const target = scheduler.getJob(idArg)
    if (!target) { await replyEphemeral(i, `❌ No job matching id \`${idArg}\`.`); return }
    if (!acl.canManage(actor, target.ownerId)) { await replyEphemeral(i, '❌ Not authorized.'); return }
    scheduler.deleteJob(target.id)
    await replyEphemeral(i, `🗑️ Deleted queued job \`${shortId(target.id)}\`.`)
    return
  }

  await replyEphemeral(i, `❌ Unknown /queue subcommand: ${sub}`)
}

/* ----------------------------- /scheduler ----------------------------- */

export async function handleScheduler(
  i: ChatInputCommandInteraction,
  ctx: CommandContext,
): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral })
  const got = requireScheduler(ctx)
  if (!got.ok) { await replyEphemeral(i, got.reason); return }
  const { acl } = got

  const sub = i.options.getSubcommand(true)
  const actor = i.user.id

  if (!acl.isOwner(actor)) {
    await replyEphemeral(i, '❌ Owner-only command.')
    return
  }

  if (!ctx.schedulerAllowlist) {
    await replyEphemeral(i, 'Scheduler allowlist API not wired.')
    return
  }

  if (sub === 'allow') {
    const user = i.options.getUser('user', true)
    ctx.schedulerAllowlist.add(user.id, actor)
    await replyEphemeral(i, `✅ <@${user.id}> added to scheduler allowlist.`)
    return
  }

  if (sub === 'deny') {
    const user = i.options.getUser('user', true)
    const removed = ctx.schedulerAllowlist.remove(user.id)
    await replyEphemeral(i, removed ? `🗑️ <@${user.id}> removed from allowlist.` : 'No such user on allowlist.')
    return
  }

  if (sub === 'allowlist') {
    const list = ctx.schedulerAllowlist.list()
    if (list.length === 0) { await replyEphemeral(i, 'Allowlist empty.'); return }
    await replyEphemeral(i, list.map(e => `<@${e.userId}> (added ${new Date(e.addedAtEpochMs).toISOString()})`).join('\n'))
    return
  }

  await replyEphemeral(i, `❌ Unknown /scheduler subcommand: ${sub}`)
}
