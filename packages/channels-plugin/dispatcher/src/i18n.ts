/**
 * Minimal i18n for the dispatcher.
 *
 * Two supported locales: `en` (source of truth) and `ko` (Korean). Handlers
 * call `t(interaction.locale, KEY, params?)` and get back a localized
 * string. Discord sends the user's client locale on every interaction
 * (`interaction.locale`), so ephemeral replies are user-specific. For
 * channel-public posts (context-pressure warnings, voice transcripts) the
 * dispatcher uses `defaultLocale()`, driven by env `PAPERCUP_DEFAULT_LOCALE`.
 *
 * Key conventions:
 *   <command>.<state>      e.g. bind.success, voice.notInChannel
 *   common.<state>         shared across commands (notInGuild, …)
 *   notice.<event>         channel-public messages from postNotice
 *
 * Translation policy for `ko`:
 *   - Polite "합니다"-form for system tones.
 *   - English code-fenced terms (e.g. `/bind`, `transport:channels`) kept
 *     verbatim so users can still copy-paste commands.
 *   - Emoji prefixes preserved across both locales.
 *   - {placeholder} syntax for runtime values; replacement is simple
 *     literal string-replace (no nested expressions, no pluralization).
 */

export type Locale = 'en' | 'ko'

export type MessageKey = keyof typeof messages

interface Entry {
  en: string
  ko: string
}

const messages = {
  // common -----------------------------------------------------------------
  'common.notInGuild': {
    en: 'Not in a guild.',
    ko: '서버 안에서만 사용할 수 있습니다.',
  },
  'common.permManageGuildBind': {
    en: 'You need the **Manage Server** permission to bind a channel.',
    ko: '채널을 바인드하려면 **서버 관리** 권한이 필요합니다.',
  },
  'common.permManageGuildUnbind': {
    en: 'You need the **Manage Server** permission to unbind a channel.',
    ko: '채널 바인드를 해제하려면 **서버 관리** 권한이 필요합니다.',
  },
  'common.permManageGuildTransport': {
    en: 'You need the **Manage Server** permission to change a session transport.',
    ko: '세션 transport를 변경하려면 **서버 관리** 권한이 필요합니다.',
  },
  'common.permManageGuildBackend': {
    en: 'You need the **Manage Server** permission to change a session backend.',
    ko: '세션 backend를 변경하려면 **서버 관리** 권한이 필요합니다.',
  },
  'common.noSessionHere': {
    en: 'No session bound to this channel. Run `/bind` first.',
    ko: '이 채널에 바인드된 세션이 없습니다. 먼저 `/bind`를 실행하세요.',
  },
  'common.sessionVanished': {
    en: 'Session vanished between lookup and update — try again.',
    ko: '세션을 조회한 후 업데이트하기 전에 사라졌습니다 — 다시 시도하세요.',
  },
  'common.couldntResolveMember': {
    en: "Couldn't resolve your guild membership.",
    ko: '서버 멤버 정보를 확인할 수 없습니다.',
  },

  // bind -------------------------------------------------------------------
  'bind.channelsClaudeOnly': {
    en: '❌ Channels transport is claude-only. Use `transport:per-turn` with backend `{backend}`.',
    ko: '❌ Channels transport는 claude 전용입니다. backend `{backend}`은(는) `transport:per-turn`과 함께 사용하세요.',
  },
  'bind.channelsNeedsTmux': {
    en: '❌ `transport:channels` requires **tmux** on this host (not installed). Install it (e.g. `apt install tmux`) and restart the dispatcher, or use `transport:per-turn`.',
    ko: '❌ `transport:channels`를 사용하려면 이 호스트에 **tmux**가 설치되어 있어야 합니다 (미설치). `apt install tmux` 등으로 설치 후 디스패처를 재시작하거나 `transport:per-turn`을 사용하세요.',
  },
  'bind.namedNotFound': {
    en: 'No session named "{name}". Omit `name` to create a fresh one, or /sessions to list.',
    ko: '"{name}"이라는 세션이 없습니다. `name`을 생략하면 새로 만들거나 /sessions로 목록을 확인하세요.',
  },
  'bind.success': {
    en: '🔗 This channel is now bound to session **{name}** (transport: `{transport}`, backend: `{backend}`). Every message here routes to it.',
    ko: '🔗 이 채널이 세션 **{name}**(transport: `{transport}`, backend: `{backend}`)에 바인드되었습니다. 여기에 보내는 모든 메시지가 이 세션으로 라우팅됩니다.',
  },

  // unbind -----------------------------------------------------------------
  'unbind.success': {
    en: '🔓 This channel is unbound. The agent session is preserved — re-bind to resume.',
    ko: '🔓 이 채널의 바인드가 해제되었습니다. 에이전트 세션은 보존되니 다시 바인드하면 이어갈 수 있습니다.',
  },
  'unbind.wasNotBound': {
    en: "This channel wasn't bound. No change.",
    ko: '이 채널은 바인드된 적이 없습니다. 변경 사항 없음.',
  },

  // sessions ---------------------------------------------------------------
  'sessions.empty': {
    en: 'No sessions yet. Run `/bind` in a channel to create one.',
    ko: '아직 세션이 없습니다. 채널에서 `/bind`를 실행해 만들어보세요.',
  },

  // status -----------------------------------------------------------------
  'status.header': {
    en: '📍 **Session `{name}`** ({transport} · {backend}) {dot} {pluginState}',
    ko: '📍 **세션 `{name}`** ({transport} · {backend}) {dot} {pluginState}',
  },
  'status.pluginOnline': {
    en: 'plugin online',
    ko: '플러그인 연결됨',
  },
  'status.pluginOffline': {
    en: 'plugin offline',
    ko: '플러그인 미연결',
  },
  'status.lineModel': {
    en: 'Model: `{value}`',
    ko: '모델: `{value}`',
  },
  'status.lineEffort': {
    en: 'Effort: `{value}`',
    ko: 'Effort: `{value}`',
  },
  'status.linePermissions': {
    en: 'Permissions: `{value}`',
    ko: '권한 모드: `{value}`',
  },
  'status.linePermissionsDefault': {
    en: 'Permissions: `{value}` (default)',
    ko: '권한 모드: `{value}` (기본값)',
  },
  'status.lineChannel': {
    en: 'Bound channel: <#{channelId}>',
    ko: '바인드 채널: <#{channelId}>',
  },
  'status.lineChannelNone': {
    en: 'Bound channel: _none_',
    ko: '바인드 채널: _없음_',
  },
  'status.lineIdle': {
    en: 'Idle: {minutes}m',
    ko: '유휴: {minutes}분',
  },
  'status.noSession': {
    en: '📭 No session bound to this channel. Run `/bind` to create one.',
    ko: '📭 이 채널에 바인드된 세션이 없습니다. `/bind`를 실행하세요.',
  },

  // rename -----------------------------------------------------------------
  'rename.success': {
    en: '✏️ Renamed to **{name}**.',
    ko: '✏️ **{name}**(으)로 이름을 변경했습니다.',
  },

  // model / models / effort / permissions ----------------------------------
  'model.set': {
    en: '🔁 Model set to **{model}**. Agent killed; next message respawns with the new flag.',
    ko: '🔁 모델을 **{model}**(으)로 설정했습니다. 에이전트가 종료되었으며 다음 메시지에서 새 플래그로 다시 실행됩니다.',
  },
  'model.cleared': {
    en: '🔁 Model override cleared (back to CLI default). Agent killed; next message respawns.',
    ko: '🔁 모델 오버라이드를 해제했습니다 (CLI 기본값으로 복귀). 에이전트가 종료되었으며 다음 메시지에서 다시 실행됩니다.',
  },
  'models.noSessionPickBackend': {
    en: 'No session bound to this channel — pass `backend:<name>` explicitly, or `/bind` here first.',
    ko: '이 채널에 바인드된 세션이 없습니다 — `backend:<name>`을 직접 지정하거나 먼저 `/bind`를 실행하세요.',
  },
  'models.noCuratedForKnown': {
    en: 'No curated entries (catalog mismatch?). Use /model name:<id> with any model id the backend accepts.',
    ko: '큐레이트된 항목이 없습니다 (카탈로그 불일치?). /model name:<id>로 backend가 허용하는 모델 id를 직접 지정하세요.',
  },
  'models.noCuratedForUnknown': {
    en: 'No curated model list for `{backend}`. Pass any model id the underlying CLI accepts via `/model name:<id>`.',
    ko: '`{backend}`에 대한 큐레이트된 모델 목록이 없습니다. `/model name:<id>`로 해당 CLI가 허용하는 모델 id를 직접 지정하세요.',
  },
  'models.headerForBackend': {
    en: '📋 Models for backend `{backend}`: {hint}',
    ko: '📋 backend `{backend}`의 모델: {hint}',
  },
  'models.headerKnown': {
    en: '📋 Models known for backend `{backend}`:',
    ko: '📋 backend `{backend}`에 등록된 모델:',
  },
  'models.applyFooter': {
    en: 'Apply one with `/model name:<id>`. /model with no name clears the override.',
    ko: '`/model name:<id>`로 적용하세요. name 없이 /model을 호출하면 오버라이드가 해제됩니다.',
  },
  'effort.set': {
    en: '🔁 Effort set to **{effort}**. Agent killed; next message respawns.',
    ko: '🔁 effort를 **{effort}**(으)로 설정했습니다. 에이전트가 종료되었으며 다음 메시지에서 다시 실행됩니다.',
  },
  'effort.cleared': {
    en: '🔁 Effort override cleared. Agent killed; next message respawns.',
    ko: '🔁 effort 오버라이드를 해제했습니다. 에이전트가 종료되었으며 다음 메시지에서 다시 실행됩니다.',
  },
  'permissions.set': {
    en: '🔐 Permission mode set to **{mode}**. Agent killed; next message respawns. ⚠️ If the policy needs interactive approval (`default`, `plan`), the bot relays prompts via Discord buttons when permission relay is enabled.',
    ko: '🔐 권한 모드를 **{mode}**(으)로 설정했습니다. 에이전트가 종료되었으며 다음 메시지에서 다시 실행됩니다. ⚠️ 정책이 인터랙티브 승인을 요구하는 경우(`default`, `plan`), permission relay가 활성화되어 있으면 봇이 Discord 버튼으로 프롬프트를 전달합니다.',
  },
  'permissions.cleared': {
    en: '🔐 Permission override cleared (back to `bypassPermissions`). Agent killed; next message respawns.',
    ko: '🔐 권한 오버라이드를 해제했습니다 (`bypassPermissions`로 복귀). 에이전트가 종료되었으며 다음 메시지에서 다시 실행됩니다.',
  },
  'permissions.planChannelsUnsupported': {
    en: '❌ Plan mode opens an interactive "Approve plan?" prompt at the terminal, which channels-transport sessions (running inside detached tmux) cannot answer. Switch this session to `transport:per-turn` first, or pick a different permission mode.',
    ko: '❌ Plan 모드는 터미널에서 인터랙티브 "Approve plan?" 프롬프트를 띄우는데, 분리된 tmux에서 실행되는 channels-transport 세션은 이에 응답할 수 없습니다. 먼저 `transport:per-turn`으로 전환하거나 다른 권한 모드를 선택하세요.',
  },

  // transport / backend ----------------------------------------------------
  'transport.alreadyOnMode': {
    en: 'Session **{name}** is already on transport `{mode}`. No change.',
    ko: '세션 **{name}**은(는) 이미 transport `{mode}`입니다. 변경 사항 없음.',
  },
  'transport.set': {
    en: '🔁 Transport set to `{mode}`. Agent killed; next message respawns.{note}',
    ko: '🔁 transport를 `{mode}`(으)로 설정했습니다. 에이전트가 종료되었으며 다음 메시지에서 다시 실행됩니다.{note}',
  },
  'transport.perTurnNote': {
    en: ' Permission relay is disabled in per-turn mode (claude runs with --dangerously-skip-permissions).',
    ko: ' per-turn 모드에서는 permission relay가 비활성화됩니다 (claude가 --dangerously-skip-permissions로 실행됨).',
  },
  'backend.alreadyOnName': {
    en: 'Session **{name}** is already on backend `{backend}`. No change.',
    ko: '세션 **{name}**은(는) 이미 backend `{backend}`입니다. 변경 사항 없음.',
  },
  'backend.channelsClaudeOnly': {
    en: '❌ This session uses the channels transport, which is claude-only. Run `/transport mode:per-turn` first, then `/backend name:{backend}`.',
    ko: '❌ 이 세션은 claude 전용인 channels transport를 사용 중입니다. 먼저 `/transport mode:per-turn`을 실행한 후 `/backend name:{backend}`을(를) 다시 호출하세요.',
  },
  'backend.set': {
    en: '🔁 Backend set to `{backend}`. Agent killed; next message respawns with the new CLI.',
    ko: '🔁 backend를 `{backend}`(으)로 설정했습니다. 에이전트가 종료되었으며 다음 메시지에서 새 CLI로 다시 실행됩니다.',
  },

  // cancel -----------------------------------------------------------------
  'cancel.aborted': {
    en: '🛑 Aborted in-flight turn for **{name}**. Next message respawns the session.',
    ko: '🛑 **{name}**의 진행 중인 turn을 중단했습니다. 다음 메시지에서 세션이 다시 실행됩니다.',
  },
  'cancel.nothing': {
    en: 'Nothing to abort — no agent running for **{name}**.',
    ko: '중단할 작업이 없습니다 — **{name}**에 실행 중인 에이전트가 없습니다.',
  },

  // voice ------------------------------------------------------------------
  'voice.unavailable': {
    en: '🔇 Voice is unavailable — the Whisper sidecar failed to start at boot. Check dispatcher logs.',
    ko: '🔇 음성을 사용할 수 없습니다 — 부팅 시 Whisper sidecar 시작에 실패했습니다. 디스패처 로그를 확인하세요.',
  },
  'voice.unavailableNothingToLeave': {
    en: '🔇 Voice is unavailable — nothing to leave.',
    ko: '🔇 음성을 사용할 수 없습니다 — 떠날 음성 채널이 없습니다.',
  },
  'voice.unavailableShort': {
    en: '🔇 Voice is unavailable.',
    ko: '🔇 음성을 사용할 수 없습니다.',
  },
  'voiceJoin.needVoiceChannelFirst': {
    en: 'Join a voice channel first, then call `/voice-join` from the bound text channel.',
    ko: '먼저 음성 채널에 입장한 뒤, 바인드된 텍스트 채널에서 `/voice-join`을 호출하세요.',
  },
  'voiceJoin.channelNotBound': {
    en: "This text channel isn't bound. Run `/bind` here first.",
    ko: '이 텍스트 채널은 바인드되어 있지 않습니다. 먼저 여기서 `/bind`를 실행하세요.',
  },
  'voiceJoin.alreadyOnLine': {
    en: 'Already on a voice line in this guild. Run `/voice-leave` first.',
    ko: '이 서버에 이미 음성 라인이 활성화되어 있습니다. 먼저 `/voice-leave`를 실행하세요.',
  },
  'voiceJoin.success': {
    en: '🎤 Joined **{channel}** — bound to session **{name}**. Speak and your transcripts will route through this text channel.',
    ko: '🎤 **{channel}**에 입장했습니다 — 세션 **{name}**에 바인드되었습니다. 말씀하시면 transcript가 이 텍스트 채널로 전달됩니다.',
  },
  'voiceLeave.left': {
    en: '👋 Left the voice channel. The agent session is preserved — text messages still work.',
    ko: '👋 음성 채널에서 나왔습니다. 에이전트 세션은 보존되며 텍스트 메시지는 계속 작동합니다.',
  },
  'voiceLeave.notOnLine': {
    en: 'No active voice line in this guild.',
    ko: '이 서버에 활성화된 음성 라인이 없습니다.',
  },

  // say --------------------------------------------------------------------
  'say.noActiveLine': {
    en: 'No active voice line. Run `/voice-join` first.',
    ko: '활성화된 음성 라인이 없습니다. 먼저 `/voice-join`을 실행하세요.',
  },
  'say.synthesizing': {
    en: '🗣️ Synthesizing: "{preview}"',
    ko: '🗣️ 음성 합성 중: "{preview}"',
  },
  'say.done': {
    en: '✅ Done.',
    ko: '✅ 완료.',
  },
  'say.ttsFailed': {
    en: '❌ TTS failed (check dispatcher logs).',
    ko: '❌ TTS 실패 (디스패처 로그를 확인하세요).',
  },

  // resume -----------------------------------------------------------------
  'resume.channelNotBound': {
    en: "This channel isn't bound. An admin needs to run `/bind` here first.",
    ko: '이 채널은 바인드되어 있지 않습니다. 관리자가 먼저 여기서 `/bind`를 실행해야 합니다.',
  },
  'resume.targetBoundElsewhere': {
    en: 'Session **{name}** is currently bound to <#{channelId}>. Run `/unbind` there first, or pick another name.',
    ko: '세션 **{name}**은(는) 현재 <#{channelId}>에 바인드되어 있습니다. 거기서 먼저 `/unbind`를 실행하거나 다른 이름을 선택하세요.',
  },
  'resume.sameAsCurrent': {
    en: 'Already on **{name}** here. No change.',
    ko: '이미 여기서 **{name}**을(를) 사용 중입니다. 변경 사항 없음.',
  },
  'resume.createdNew': {
    en: '🆕 Started new session **{name}** — this channel routes to it now.{parked}',
    ko: '🆕 새 세션 **{name}**을(를) 시작했습니다 — 이 채널이 이제 이 세션으로 라우팅됩니다.{parked}',
  },
  'resume.switchedTo': {
    en: '🔁 Resumed **{name}** — this channel routes to it now.{parked}',
    ko: '🔁 **{name}**을(를) 재개했습니다 — 이 채널이 이제 이 세션으로 라우팅됩니다.{parked}',
  },
  'resume.parkedNote': {
    en: ' Previous session **{name}** parked — warm agent stopped; run `/resume name:{name}` to bring it back (transcript preserved).',
    ko: ' 이전 세션 **{name}**을(를) 보관 중입니다 — 실행 중이던 에이전트는 중지되었지만 `/resume name:{name}`으로 복귀할 수 있습니다 (transcript 보존).',
  },

  // compact ----------------------------------------------------------------
  'compact.targetNotFoundNamed': {
    en: 'No session named "{name}". `/sessions` to list.',
    ko: '"{name}"이라는 세션이 없습니다. `/sessions`로 목록을 확인하세요.',
  },
  'compact.targetNotFound': {
    en: 'No session bound to this channel. Pass `name:<session>` or `/bind` here first.',
    ko: '이 채널에 바인드된 세션이 없습니다. `name:<session>`을 전달하거나 먼저 `/bind`를 실행하세요.',
  },
  'compact.failed': {
    en: '❌ Compact failed: {error}',
    ko: '❌ Compact 실패: {error}',
  },

  // pickup -----------------------------------------------------------------
  'pickup.needVoiceChannelFirst': {
    en: 'Join a voice channel first, then call `/pickup`.',
    ko: '먼저 음성 채널에 입장한 뒤 `/pickup`을 호출하세요.',
  },
  'pickup.alreadyOnLine': {
    en: 'Already on a voice line in this guild. Run `/hangup` first.',
    ko: '이 서버에 이미 음성 라인이 활성화되어 있습니다. 먼저 `/hangup`을 실행하세요.',
  },
  'pickup.success': {
    en: '📞 **Picked up** — joined **{channel}**, bound to session **{name}**.\n`transport={transport}` · `backend={backend}` · `model={model}` · `effort={effort}`\nSpeak to talk; replies post here + TTS to voice. `/hangup` to end the call (text session preserved).',
    ko: '📞 **연결됨** — **{channel}**에 입장했고 세션 **{name}**에 바인드되었습니다.\n`transport={transport}` · `backend={backend}` · `model={model}` · `effort={effort}`\n말씀하시면 답변은 여기에 게시되고 TTS로 음성에 재생됩니다. 통화를 종료하려면 `/hangup` (텍스트 세션은 보존됩니다).',
  },

  // generic error envelope -------------------------------------------------
  'common.errorPrefix': {
    en: '❌ {error}',
    ko: '❌ {error}',
  },

  // channel-public notices -------------------------------------------------
  'notice.contextWarn': {
    en: '⚠️ **Context getting heavy** — {kTokens}k input tokens used. Consider /compact if responses slow down.',
    ko: '⚠️ **컨텍스트가 무거워지고 있습니다** — 입력 토큰 {kTokens}k 사용 중. 응답이 느려진다면 /compact를 고려하세요.',
  },
  'notice.contextDanger': {
    en: '🛑 **Context danger zone** — {kTokens}k input tokens used. Compact or start a fresh session soon.',
    ko: '🛑 **컨텍스트 위험 구간** — 입력 토큰 {kTokens}k 사용 중. 곧 compact하거나 새 세션을 시작하세요.',
  },
  'notice.voiceTranscript': {
    en: '🎙️ {text}',
    ko: '🎙️ {text}',
  },
  'notice.transportNotReady': {
    en: 'transport not yet ready for this session; dropping message {messageId}. (Plugin handshake takes ~1-2s after spawn — resend.)',
    ko: '이 세션의 transport가 아직 준비되지 않았습니다; 메시지 {messageId}를 폐기했습니다. (플러그인 핸드셰이크에 ~1-2초가 걸립니다 — 다시 보내주세요.)',
  },
} satisfies Record<string, Entry>

const DEFAULT_LOCALE: Locale = (() => {
  const env = (process.env.PAPERCUP_DEFAULT_LOCALE ?? '').toLowerCase()
  if (env === 'ko' || env.startsWith('ko-')) return 'ko'
  return 'en'
})()

/**
 * Coerce a Discord locale tag (e.g. 'en-US', 'ko') into one of our supported
 * locales. Unknown locales fall back to English.
 */
export function pickLocale(raw: string | null | undefined): Locale {
  if (!raw) return DEFAULT_LOCALE
  const v = raw.toLowerCase()
  if (v === 'ko' || v.startsWith('ko-')) return 'ko'
  return 'en'
}

export function defaultLocale(): Locale {
  return DEFAULT_LOCALE
}

/**
 * Translate a key with optional {placeholder} interpolation. Unknown keys
 * return the key string itself (cheap fail-safe — easier to spot in UI than
 * a thrown error). Missing translations fall back to en.
 */
export function t(
  locale: Locale | string | null | undefined,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const entry = messages[key]
  if (!entry) return String(key)
  const lang: Locale = typeof locale === 'string' ? pickLocale(locale) : (locale ?? DEFAULT_LOCALE)
  let out = entry[lang] ?? entry.en
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      // split/join replaces all occurrences without needing 'g' regex flag.
      out = out.split('{' + k + '}').join(String(v))
    }
  }
  return out
}

/**
 * For Discord native slash-command localization. Returns an object of the
 * form { ko: '...' } suitable for setNameLocalizations /
 * setDescriptionLocalizations. English is the builder's default (set via
 * setDescription); this only adds the ko translation.
 */
export function koOf(key: MessageKey): { ko: string } {
  return { ko: messages[key].ko }
}
