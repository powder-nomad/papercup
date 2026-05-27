import type { Interaction } from 'discord.js'
import {
  handleBind,
  handleUnbind,
  handleSessions,
  handleStatus,
  handleRespawn,
  handleRename,
  handleModel,
  handleEffort,
  handlePermissions,
  handleCancel,
  handleVoiceJoin,
  handleVoiceLeave,
  handleSay,
  handleCompact,
  handleResume,
  handleTransport,
  handleBackend,
  handleModels,
  handleAutocomplete,
  handlePickup,
  handleHangup,
} from './handlers.ts'
import { handleCron, handleQueue, handleScheduler } from './scheduler-cmds.ts'
import type { CommandContext } from './types.ts'

/**
 * Discord `interactionCreate` dispatcher. Wired into the client in
 * dispatcher/src/discord.ts; each chat-input command routes to a handler
 * in ./handlers.ts.
 */
const PERMISSION_BUTTON_RE = /^perm:(allow|deny):(.+)$/

export async function dispatchInteraction(
  interaction: Interaction,
  ctx: CommandContext,
): Promise<void> {
  if (interaction.isButton()) {
    const m = PERMISSION_BUTTON_RE.exec(interaction.customId)
    if (!m) return
    const behavior = m[1] as 'allow' | 'deny'
    const requestId = m[2]
    const ok = ctx.resolvePermission(requestId, behavior, interaction.user.id)
    if (!ok) {
      await interaction
        .reply({
          content: 'Not authorized, or the request has already been answered.',
          ephemeral: true,
        })
        .catch(() => {})
      return
    }
    const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
    // Strip the buttons + append the resolution so the request can't be answered twice.
    await interaction
      .update({
        content: `${interaction.message.content}\n\n**${label}** by <@${interaction.user.id}>`,
        components: [],
      })
      .catch(() => {})
    return
  }
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction, ctx)
    return
  }
  if (!interaction.isChatInputCommand()) return
  try {
    switch (interaction.commandName) {
      case 'bind':
        await handleBind(interaction, ctx)
        return
      case 'unbind':
        await handleUnbind(interaction, ctx)
        return
      case 'sessions':
        await handleSessions(interaction, ctx)
        return
      case 'status':
        await handleStatus(interaction, ctx)
        return
      case 'respawn':
        await handleRespawn(interaction, ctx)
        return
      case 'rename':
        await handleRename(interaction, ctx)
        return
      case 'model':
        await handleModel(interaction, ctx)
        return
      case 'effort':
        await handleEffort(interaction, ctx)
        return
      case 'permissions':
        await handlePermissions(interaction, ctx)
        return
      case 'cancel':
        await handleCancel(interaction, ctx)
        return
      case 'voice-join':
        await handleVoiceJoin(interaction, ctx)
        return
      case 'voice-leave':
        await handleVoiceLeave(interaction, ctx)
        return
      case 'say':
        await handleSay(interaction, ctx)
        return
      case 'compact':
        await handleCompact(interaction, ctx)
        return
      case 'resume':
        await handleResume(interaction, ctx)
        return
      case 'transport':
        await handleTransport(interaction, ctx)
        return
      case 'backend':
        await handleBackend(interaction, ctx)
        return
      case 'models':
        await handleModels(interaction, ctx)
        return
      case 'pickup':
        await handlePickup(interaction, ctx)
        return
      case 'hangup':
        await handleHangup(interaction, ctx)
        return
      case 'cron':
        await handleCron(interaction, ctx)
        return
      case 'queue':
        await handleQueue(interaction, ctx)
        return
      case 'scheduler':
        await handleScheduler(interaction, ctx)
        return
      default:
        if (interaction.deferred || interaction.replied) return
        await interaction.reply({
          content: `unknown command: ${interaction.commandName}`,
          ephemeral: true,
        })
    }
  } catch (err) {
    console.error('[commands] handler error:', err)
    if (interaction.deferred) {
      await interaction.editReply(`❌ Handler error: ${(err as Error).message}`).catch(() => {})
    } else if (!interaction.replied) {
      await interaction
        .reply({ content: `❌ Handler error: ${(err as Error).message}`, ephemeral: true })
        .catch(() => {})
    }
  }
}
