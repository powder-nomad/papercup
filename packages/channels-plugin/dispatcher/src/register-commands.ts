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
    .setDescriptionLocalizations({ ko: '(관리자) 이 채널을 claude 세션에 바인드 — 모든 메시지가 해당 세션으로 라우팅됩니다.' })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o =>
      o
        .setName('name')
        .setDescription("Session name to bind. Omit to reuse this channel's session or create a fresh one.")
        .setDescriptionLocalizations({ ko: '바인드할 세션 이름. 생략하면 이 채널의 세션을 재사용하거나 새로 만듭니다.' })
        .setRequired(false)
        .setMaxLength(60),
    )
    .addStringOption(o =>
      o
        .setName('transport')
        .setDescription(
          'Transport mode for new sessions. channels = long-lived; per-turn = phone-call-style interrupt UX.',
        )
        .setDescriptionLocalizations({ ko: '새 세션의 transport. channels = 장기 세션; per-turn = 전화 통화처럼 중간 끼어들기 UX.' })
        .setRequired(false)
        .addChoices(
          { name: 'channels (long-lived, default)', value: 'channels', name_localizations: { ko: 'channels (장기 세션, 기본값)' } },
          { name: 'per-turn (phone-call interrupts, no permission relay)', value: 'per-turn', name_localizations: { ko: 'per-turn (전화 통화 중간 끼어들기, permission relay 없음)' } },
        ),
    )
    .addStringOption(o =>
      o
        .setName('backend')
        .setDescription('Backend agent CLI. Defaults to claude-code. Non-claude backends require transport:per-turn.')
        .setDescriptionLocalizations({ ko: 'Backend 에이전트 CLI. 기본값 claude-code. claude 외에는 transport:per-turn이 필요합니다.' })
        .setRequired(false)
        .addChoices(
          { name: 'claude-code (default)', value: 'claude-code', name_localizations: { ko: 'claude-code (기본값)' } },
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
    .setDescriptionLocalizations({ ko: '(관리자) 이 채널 세션의 transport를 변경합니다. 종료 + 재시작.' })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o =>
      o
        .setName('mode')
        .setDescription('Transport mode')
        .setDescriptionLocalizations({ ko: 'Transport 모드' })
        .setRequired(true)
        .addChoices(
          { name: 'channels (long-lived)', value: 'channels', name_localizations: { ko: 'channels (장기 세션)' } },
          { name: 'per-turn (phone-call interrupts)', value: 'per-turn', name_localizations: { ko: 'per-turn (전화 통화 중간 끼어들기)' } },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('backend')
    .setDescription("(Admin) Switch this channel's bound session to a different backend CLI. Kills + respawns.")
    .setDescriptionLocalizations({ ko: '(관리자) 이 채널 세션의 backend CLI를 변경합니다. 종료 + 재시작.' })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o =>
      o
        .setName('name')
        .setDescription('Backend agent CLI')
        .setDescriptionLocalizations({ ko: 'Backend 에이전트 CLI' })
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
    .setDescription('(Admin) Unbind THIS channel — stops the running agent; session metadata is kept.')
    .setDescriptionLocalizations({ ko: '(관리자) 이 채널의 바인드를 해제 — 실행 중인 에이전트를 종료하고 세션 정보는 보존합니다.' })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('sessions')
    .setDescription('List recent claude sessions (current channel binding marked).')
    .setDescriptionLocalizations({ ko: '최근 세션 목록을 표시합니다 (현재 채널 바인드가 표시됨).' })
    .toJSON(),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription("Show this channel's session: transport, backend, model, effort, permissions, idle.")
    .setDescriptionLocalizations({ ko: '이 채널 세션의 상태 (transport, backend, model, effort, 권한, 유휴 시간).' })
    .toJSON(),
  new SlashCommandBuilder()
    .setName('respawn')
    .setDescription("Kill (if alive) + respawn this channel's agent. Use when /status shows plugin offline.")
    .setDescriptionLocalizations({ ko: '이 채널 에이전트를 종료 후 재실행합니다. `/status`에서 플러그인이 오프라인일 때 사용하세요.' })
    .toJSON(),
  new SlashCommandBuilder()
    .setName('rename')
    .setDescription('Rename the session bound to THIS channel.')
    .setDescriptionLocalizations({ ko: '이 채널에 바인드된 세션의 이름을 변경합니다.' })
    .addStringOption(o =>
      o.setName('name')
        .setDescription('New name')
        .setDescriptionLocalizations({ ko: '새 이름' })
        .setRequired(true).setMaxLength(60),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Set the model for this channel\'s session. Suggestions are backend-aware.')
    .setDescriptionLocalizations({ ko: '이 채널 세션의 모델을 설정합니다. backend별 추천이 표시됩니다.' })
    .addStringOption(o =>
      o
        .setName('name')
        .setDescription('Model id. Type to see suggestions for this channel\'s backend, or leave blank to clear.')
        .setDescriptionLocalizations({ ko: '모델 id. 입력하면 backend별 추천을 보고, 비워두면 오버라이드를 해제합니다.' })
        .setRequired(false)
        .setAutocomplete(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('models')
    .setDescription("List models known for a backend (defaults to this channel's current backend).")
    .setDescriptionLocalizations({ ko: 'backend의 등록된 모델 목록 (기본값은 이 채널의 현재 backend).' })
    .addStringOption(o =>
      o
        .setName('backend')
        .setDescription('Backend agent CLI. Defaults to this channel\'s session backend.')
        .setDescriptionLocalizations({ ko: 'Backend 에이전트 CLI. 기본값은 이 채널 세션의 backend입니다.' })
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
    .setDescriptionLocalizations({ ko: '이 채널 세션의 reasoning effort를 설정합니다.' })
    .addStringOption(o =>
      o
        .setName('level')
        .setDescription("Reasoning effort. 'default' clears the override.")
        .setDescriptionLocalizations({ ko: "Reasoning effort. 'default'로 오버라이드를 해제합니다." })
        .setRequired(true)
        .addChoices(
          { name: 'minimal', value: 'minimal' },
          { name: 'low', value: 'low' },
          { name: 'medium', value: 'medium' },
          { name: 'high', value: 'high' },
          { name: 'xhigh (Opus only)', value: 'xhigh', name_localizations: { ko: 'xhigh (Opus 전용)' } },
          { name: 'max (Opus only)', value: 'max', name_localizations: { ko: 'max (Opus 전용)' } },
          { name: 'default (clear override)', value: 'default', name_localizations: { ko: 'default (오버라이드 해제)' } },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('permissions')
    .setDescription('Set the tool permission policy for this channel\'s session.')
    .setDescriptionLocalizations({ ko: '이 채널 세션의 도구 권한 정책을 설정합니다.' })
    .addStringOption(o =>
      o
        .setName('mode')
        .setDescription("Permission mode. 'default-for-mode' clears the override (uses bypassPermissions).")
        .setDescriptionLocalizations({ ko: "권한 모드. 'default-for-mode'로 오버라이드 해제 (bypassPermissions 사용)." })
        .setRequired(true)
        .addChoices(
          { name: 'default (prompt — needs permission relay)', value: 'default', name_localizations: { ko: 'default (프롬프트 — permission relay 필요)' } },
          { name: 'acceptEdits', value: 'acceptEdits' },
          { name: 'auto', value: 'auto' },
          { name: 'bypassPermissions', value: 'bypassPermissions' },
          { name: 'plan (read-only)', value: 'plan', name_localizations: { ko: 'plan (읽기 전용)' } },
          { name: 'default-for-mode (clear override)', value: 'default-for-mode', name_localizations: { ko: 'default-for-mode (오버라이드 해제)' } },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('cancel')
    .setDescription("Abort the in-flight turn for this channel's session (stops the running agent).")
    .setDescriptionLocalizations({ ko: '이 채널 세션의 진행 중 turn 중단 (실행 중인 에이전트를 종료).' })
    .toJSON(),
  new SlashCommandBuilder()
    .setName('voice-join')
    .setDescription("Bot joins your voice channel and routes your speech into the bound text channel's session.")
    .setDescriptionLocalizations({ ko: '봇이 음성 채널에 입장하여 음성을 바인드된 텍스트 채널의 세션으로 전달합니다.' })
    .toJSON(),
  new SlashCommandBuilder()
    .setName('voice-leave')
    .setDescription('Bot leaves the voice channel. Text session is preserved for text messages.')
    .setDescriptionLocalizations({ ko: '봇이 음성 채널에서 나갑니다. 텍스트 세션은 텍스트 메시지용으로 보존됩니다.' })
    .toJSON(),
  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Make the bot speak arbitrary text in the active voice line (debug).')
    .setDescriptionLocalizations({ ko: '활성 음성 라인에서 봇이 임의의 텍스트를 말하게 합니다 (디버그용).' })
    .addStringOption(o =>
      o.setName('text')
        .setDescription('Text to speak')
        .setDescriptionLocalizations({ ko: '말할 텍스트' })
        .setRequired(true).setMaxLength(500),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('compact')
    .setDescription("Summarise this channel's session into a new forked session seeded with the handoff.")
    .setDescriptionLocalizations({ ko: '이 채널 세션을 요약해 handoff와 함께 새 포크 세션으로 분기합니다.' })
    .addStringOption(o =>
      o
        .setName('name')
        .setDescription("Session name to compact. Defaults to this channel's bound session.")
        .setDescriptionLocalizations({ ko: 'Compact할 세션 이름. 기본값은 이 채널의 바인드된 세션.' })
        .setRequired(false)
        .setMaxLength(60),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription("Switch this channel to a named session (create if missing). Mirrors `claude --resume`.")
    .setDescriptionLocalizations({ ko: '이 채널을 지정한 이름의 세션으로 전환 (없으면 생성). `claude --resume`과 동일.' })
    .addStringOption(o =>
      o
        .setName('name')
        .setDescription('Session name. New if not found.')
        .setDescriptionLocalizations({ ko: '세션 이름. 존재하지 않으면 새로 만듭니다.' })
        .setRequired(true)
        .setMaxLength(60),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('pickup')
    .setDescription('Bot joins your voice channel + binds this text channel. One-step /bind + /voice-join.')
    .setDescriptionLocalizations({ ko: '봇이 음성 채널에 입장하고 이 텍스트 채널을 바인드. /bind + /voice-join 한 번에 실행.' })
    .addStringOption(o =>
      o
        .setName('backend')
        .setDescription('Backend agent CLI. Defaults to PAPERCUP_VOICE_DEFAULT_BACKEND or gemini-cli.')
        .setDescriptionLocalizations({ ko: 'Backend 에이전트 CLI. 기본값은 PAPERCUP_VOICE_DEFAULT_BACKEND 또는 gemini-cli.' })
        .setRequired(false)
        .addChoices(
          { name: 'claude-code', value: 'claude-code' },
          { name: 'codex', value: 'codex' },
          { name: 'gemini-cli (voice default)', value: 'gemini-cli', name_localizations: { ko: 'gemini-cli (음성 기본값)' } },
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
        .setDescriptionLocalizations({ ko: '모델 id. 입력하면 선택한 backend의 추천 모델을 봅니다.' })
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption(o =>
      o
        .setName('effort')
        .setDescription('Reasoning effort (ignored by non-claude backends).')
        .setDescriptionLocalizations({ ko: 'Reasoning effort (claude 외 backend에서는 무시됨).' })
        .setRequired(false)
        .addChoices(
          { name: 'minimal (voice default)', value: 'minimal', name_localizations: { ko: 'minimal (음성 기본값)' } },
          { name: 'low', value: 'low' },
          { name: 'medium', value: 'medium' },
          { name: 'high', value: 'high' },
          { name: 'xhigh (Opus only)', value: 'xhigh', name_localizations: { ko: 'xhigh (Opus 전용)' } },
          { name: 'max (Opus only)', value: 'max', name_localizations: { ko: 'max (Opus 전용)' } },
        ),
    )
    .addStringOption(o =>
      o
        .setName('transport')
        .setDescription('Transport mode. Defaults to PAPERCUP_VOICE_DEFAULT_TRANSPORT or per-turn (better for voice).')
        .setDescriptionLocalizations({ ko: 'Transport 모드. 기본값은 PAPERCUP_VOICE_DEFAULT_TRANSPORT 또는 per-turn.' })
        .setRequired(false)
        .addChoices(
          { name: 'per-turn (voice default — phone-call interrupts)', value: 'per-turn', name_localizations: { ko: 'per-turn (음성 기본값 — 전화 통화 중간 끼어들기)' } },
          { name: 'channels (long-lived; warm cache, slower cold start)', value: 'channels', name_localizations: { ko: 'channels (장기 세션; 캐시 유지, 콜드 스타트 느림)' } },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('hangup')
    .setDescription('Bot leaves the voice channel. Alias for /voice-leave (text session preserved).')
    .setDescriptionLocalizations({ ko: '봇이 음성 채널에서 나갑니다. /voice-leave의 별칭 (텍스트 세션 보존).' })
    .toJSON(),
  new SlashCommandBuilder()
    .setName('cron')
    .setDescription('Recurring cron prompts that fire into a session.')
    .setDescriptionLocalizations({ ko: '세션에 주기적으로 프롬프트를 전송하는 cron 작업.' })
    .addSubcommand(s =>
      s
        .setName('add')
        .setDescription('Register a new cron job.')
        .setDescriptionLocalizations({ ko: '새로운 cron 작업을 등록합니다.' })
        .addStringOption(o =>
          o.setName('expr').setDescription('Cron expression, e.g. "0 9 * * *".')
           .setDescriptionLocalizations({ ko: 'cron 표현식 (예: "0 9 * * *").' })
           .setRequired(true).setMaxLength(120),
        )
        .addStringOption(o =>
          o.setName('prompt').setDescription('Prompt body to send on each fire.')
           .setDescriptionLocalizations({ ko: '각 발화 시 전송할 프롬프트.' })
           .setRequired(true).setMaxLength(1800),
        )
        .addStringOption(o =>
          o.setName('session').setDescription('Target session name or id. Defaults to this channel\'s bound session.')
           .setDescriptionLocalizations({ ko: '대상 세션 이름 또는 id. 생략 시 이 채널에 바인드된 세션을 사용합니다.' })
           .setRequired(false).setMaxLength(80),
        ),
    )
    .addSubcommand(s =>
      s
        .setName('list')
        .setDescription('List cron jobs you can see (owner: all; others: own).')
        .setDescriptionLocalizations({ ko: '볼 수 있는 cron 작업 목록 (오너: 전체; 그 외: 본인 것만).' })
        .addStringOption(o =>
          o.setName('session').setDescription('Filter by session name or id.')
           .setDescriptionLocalizations({ ko: '세션 이름/id로 필터링.' })
           .setRequired(false).setMaxLength(80),
        ),
    )
    .addSubcommand(s =>
      s
        .setName('delete')
        .setDescription('Delete a cron job by id (8-char prefix accepted).')
        .setDescriptionLocalizations({ ko: 'id로 cron 작업 삭제 (8자리 prefix 허용).' })
        .addStringOption(o =>
          o.setName('id').setDescription('Job id or 8-char prefix.')
           .setDescriptionLocalizations({ ko: '작업 id 또는 8자리 prefix.' })
           .setRequired(true).setMaxLength(40),
        ),
    )
    .addSubcommand(s =>
      s
        .setName('edit')
        .setDescription('Toggle enabled state on a cron job.')
        .setDescriptionLocalizations({ ko: 'cron 작업의 활성화 상태 변경.' })
        .addStringOption(o =>
          o.setName('id').setDescription('Job id or 8-char prefix.')
           .setDescriptionLocalizations({ ko: '작업 id 또는 8자리 prefix.' })
           .setRequired(true).setMaxLength(40),
        )
        .addBooleanOption(o =>
          o.setName('enabled').setDescription('true = enable, false = disable.')
           .setDescriptionLocalizations({ ko: 'true=활성화, false=비활성화.' })
           .setRequired(false),
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('One-shot prompts that fire at a specific time.')
    .setDescriptionLocalizations({ ko: '특정 시각에 한 번 발화되는 프롬프트.' })
    .addSubcommand(s =>
      s
        .setName('add')
        .setDescription('Queue a prompt to fire at a specific time (ISO 8601 / HH:mm / +Nh|m|d).')
        .setDescriptionLocalizations({ ko: '특정 시각에 발화될 프롬프트 등록 (ISO 8601 / HH:mm / +Nh|m|d).' })
        .addStringOption(o =>
          o.setName('at').setDescription('When to fire. e.g. "+2h", "23:30", "2026-12-31T09:00:00".')
           .setDescriptionLocalizations({ ko: '발화 시각 (예: "+2h", "23:30", "2026-12-31T09:00:00").' })
           .setRequired(true).setMaxLength(60),
        )
        .addStringOption(o =>
          o.setName('prompt').setDescription('Prompt body to send.')
           .setDescriptionLocalizations({ ko: '전송할 프롬프트 내용.' })
           .setRequired(true).setMaxLength(1800),
        )
        .addStringOption(o =>
          o.setName('session').setDescription('Target session name or id. Defaults to this channel\'s session.')
           .setDescriptionLocalizations({ ko: '대상 세션 이름/id. 생략 시 이 채널의 세션 사용.' })
           .setRequired(false).setMaxLength(80),
        ),
    )
    .addSubcommand(s =>
      s
        .setName('list')
        .setDescription('List queued jobs.')
        .setDescriptionLocalizations({ ko: '대기 중인 작업 목록.' })
        .addStringOption(o =>
          o.setName('session').setDescription('Filter by session name or id.')
           .setDescriptionLocalizations({ ko: '세션 이름/id로 필터링.' })
           .setRequired(false).setMaxLength(80),
        ),
    )
    .addSubcommand(s =>
      s
        .setName('delete')
        .setDescription('Delete a queued job by id.')
        .setDescriptionLocalizations({ ko: 'id로 대기 중인 작업 삭제.' })
        .addStringOption(o =>
          o.setName('id').setDescription('Job id or 8-char prefix.')
           .setDescriptionLocalizations({ ko: '작업 id 또는 8자리 prefix.' })
           .setRequired(true).setMaxLength(40),
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('scheduler')
    .setDescription('(Owner only) Manage the scheduler allowlist.')
    .setDescriptionLocalizations({ ko: '(오너 전용) 스케줄러 allowlist 관리.' })
    .addSubcommand(s =>
      s
        .setName('allow')
        .setDescription('Add a user to the scheduler allowlist.')
        .setDescriptionLocalizations({ ko: 'allowlist에 사용자 추가.' })
        .addUserOption(o =>
          o.setName('user').setDescription('Discord user to allow.')
           .setDescriptionLocalizations({ ko: '허용할 사용자.' })
           .setRequired(true),
        ),
    )
    .addSubcommand(s =>
      s
        .setName('deny')
        .setDescription('Remove a user from the scheduler allowlist.')
        .setDescriptionLocalizations({ ko: 'allowlist에서 사용자 제거.' })
        .addUserOption(o =>
          o.setName('user').setDescription('Discord user to remove.')
           .setDescriptionLocalizations({ ko: '제거할 사용자.' })
           .setRequired(true),
        ),
    )
    .addSubcommand(s =>
      s
        .setName('allowlist')
        .setDescription('List current scheduler allowlist members.')
        .setDescriptionLocalizations({ ko: '현재 allowlist 멤버 조회.' }),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('limit-handler')
    .setDescription('Configure per-session backend usage-limit auto-resume.')
    .setDescriptionLocalizations({ ko: '세션별 백엔드 사용 한도 자동 재개 설정.' })
    .addSubcommand(s =>
      s
        .setName('show')
        .setDescription('Show current limit-handler config for a session.')
        .setDescriptionLocalizations({ ko: '현재 limit-handler 설정 조회.' })
        .addStringOption(o =>
          o.setName('session').setDescription('Target session name or id. Defaults to this channel\'s session.')
           .setDescriptionLocalizations({ ko: '세션 이름/ID. 생략 시 채널의 세션.' })
           .setRequired(false),
        ),
    )
    .addSubcommand(s =>
      s
        .setName('mode')
        .setDescription('Set how this session reacts to backend usage-limit hits.')
        .setDescriptionLocalizations({ ko: '사용 한도 도달 시 동작 모드 설정.' })
        .addStringOption(o =>
          o.setName('mode').setDescription('auto-nudge | ask-user (deferred) | off')
           .setDescriptionLocalizations({ ko: 'auto-nudge | ask-user (보류) | off' })
           .setRequired(true)
           .addChoices(
             { name: 'auto-nudge', value: 'auto-nudge' },
             { name: 'ask-user (deferred)', value: 'ask-user' },
             { name: 'off', value: 'off' },
           ),
        )
        .addStringOption(o =>
          o.setName('session').setDescription('Target session name or id. Defaults to this channel\'s session.')
           .setDescriptionLocalizations({ ko: '세션 이름/ID. 생략 시 채널의 세션.' })
           .setRequired(false),
        ),
    )
    .addSubcommand(s =>
      s
        .setName('set-nudge')
        .setDescription('Set the prompt sent after the limit resets (auto-nudge mode).')
        .setDescriptionLocalizations({ ko: '한도 리셋 후 보낼 프롬프트 설정.' })
        .addStringOption(o =>
          o.setName('text').setDescription('Nudge text (1..500 chars).')
           .setDescriptionLocalizations({ ko: '프롬프트 (1..500자).' })
           .setRequired(true)
           .setMaxLength(500),
        )
        .addStringOption(o =>
          o.setName('session').setDescription('Target session name or id. Defaults to this channel\'s session.')
           .setDescriptionLocalizations({ ko: '세션 이름/ID. 생략 시 채널의 세션.' })
           .setRequired(false),
        ),
    )
    .addSubcommand(s =>
      s
        .setName('set-grace')
        .setDescription('Extra seconds to wait after the limit reset before sending the nudge.')
        .setDescriptionLocalizations({ ko: '리셋 후 nudge 발송까지 대기할 추가 초 수.' })
        .addIntegerOption(o =>
          o.setName('seconds').setDescription('0..3600 seconds.')
           .setDescriptionLocalizations({ ko: '0..3600초.' })
           .setRequired(true)
           .setMinValue(0)
           .setMaxValue(3600),
        )
        .addStringOption(o =>
          o.setName('session').setDescription('Target session name or id. Defaults to this channel\'s session.')
           .setDescriptionLocalizations({ ko: '세션 이름/ID. 생략 시 채널의 세션.' })
           .setRequired(false),
        ),
    )
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
