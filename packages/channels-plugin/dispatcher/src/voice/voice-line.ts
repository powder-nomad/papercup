/**
 * VoiceService — owns the dispatcher's voice subsystem.
 *
 *   • One STT sidecar (WhisperSidecar) and one TTS engine, shared across all
 *     voice lines.
 *   • Map<guildId, VoiceLine> — at most one voice connection per Discord guild.
 *
 * Lifecycle:
 *   • dispatcher boots → bootWhisperSidecar() → createTts() → new VoiceService()
 *   • /voice-join in a bound text channel → service.join({...}) → connection
 *     opens, AudioPlayer subscribed, CaptureLoop started
 *   • capture loop fires onUtterance → service emits to dispatcher's transcript
 *     handler, which packages it as a UDS `event` with meta.source=voice
 *   • dispatcher's uds.on('reply', ...) handler calls service.speak(guildId, text)
 *     after the text post; if a line exists, synthesise + play
 *   • /voice-leave → service.leave(guildId) → destroys VoiceConnection but
 *     keeps the underlying session alive
 *
 * Idle-reaper integration: the reaper consults isSessionConnected(sessionId) and
 * skips sessions with an active voice line OR any audio frame in the last 60s.
 */

import {
  joinVoiceChannel,
  createAudioPlayer,
  AudioPlayerStatus,
  entersState,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  type AudioPlayer,
  type VoiceConnection,
  type DiscordGatewayAdapterCreator,
} from '@discordjs/voice'
import type { WhisperSidecar } from '@papercup/voice-stack/stt'
import type { TtsEngine } from '@papercup/voice-stack/tts'
import { CaptureLoop } from './capture.ts'
import { synthesizeAndPlay, whenIdle, type SpeakOpts } from './playback.ts'
import { makeLogger } from '../log.ts'

const log = makeLogger('voice')

const SILENCE_MS = Number(process.env.PAPERCUP_SILENCE_MS ?? 600)
const VAD_THRESHOLD = Number(process.env.PAPERCUP_VAD_THRESHOLD ?? 0.4)
const VAD_MIN_SPEECH_WINDOWS = Number(process.env.PAPERCUP_VAD_MIN_SPEECH_WINDOWS ?? 3)

export type VoiceUtterance = {
  sessionId: string
  guildId: string
  textChannelId: string
  voiceChannelId: string
  userId: string
  text: string
  lang: string | null
  ts: string
}

export type VoiceServiceOpts = {
  stt: WhisperSidecar
  tts: TtsEngine
  onUtterance: (u: VoiceUtterance) => void
}

export type JoinOpts = {
  sessionId: string
  guildId: string
  voiceChannelId: string
  textChannelId: string
  userId: string
  adapterCreator: DiscordGatewayAdapterCreator
}

export type VoiceLine = {
  sessionId: string
  guildId: string
  voiceChannelId: string
  textChannelId: string
  userId: string
  connection: VoiceConnection
  player: AudioPlayer
  capture: CaptureLoop
  lastAudioAt: number
  playingSince: number | null
}

export class VoiceService {
  private byGuild = new Map<string, VoiceLine>()
  private bySession = new Map<string, string>() // sessionId → guildId

  constructor(private opts: VoiceServiceOpts) {}

  has(guildId: string): boolean {
    return this.byGuild.has(guildId)
  }

  get(guildId: string): VoiceLine | undefined {
    return this.byGuild.get(guildId)
  }

  getBySession(sessionId: string): VoiceLine | undefined {
    const guildId = this.bySession.get(sessionId)
    return guildId ? this.byGuild.get(guildId) : undefined
  }

  isSessionConnected(sessionId: string): boolean {
    const line = this.getBySession(sessionId)
    if (!line) return false
    return line.connection.state.status !== VoiceConnectionStatus.Destroyed
  }

  lastAudioAgeMs(sessionId: string): number | undefined {
    const line = this.getBySession(sessionId)
    if (!line) return undefined
    return Date.now() - line.lastAudioAt
  }

  isPlaying(guildId: string): boolean {
    const line = this.byGuild.get(guildId)
    if (!line) return false
    return line.player.state.status !== AudioPlayerStatus.Idle
  }

  async join(opts: JoinOpts): Promise<VoiceLine> {
    if (this.byGuild.has(opts.guildId)) {
      throw new Error(`already on a voice line in guild ${opts.guildId}`)
    }
    log.info(
      `joining: session=${opts.sessionId.slice(0, 8)}, voice=${opts.voiceChannelId}, text=${opts.textChannelId}, user=${opts.userId}`,
    )
    const connection = joinVoiceChannel({
      channelId: opts.voiceChannelId,
      guildId: opts.guildId,
      adapterCreator: opts.adapterCreator,
      selfDeaf: false,
      selfMute: false,
    })
    connection.on('stateChange', (oldState, newState) => {
      log.info(`connection ${oldState.status} → ${newState.status} (guild=${opts.guildId})`)
    })
    connection.on('error', err => log.warn(`connection error (guild=${opts.guildId}):`, err))

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    })
    player.on('error', err => log.warn(`player error (guild=${opts.guildId}):`, err))
    connection.subscribe(player)

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000)
    } catch (err) {
      log.warn(`voice connection did not reach Ready in 15s: ${(err as Error).message}`)
      try { connection.destroy() } catch { /* ignore */ }
      throw new Error("voice connection failed (didn't reach Ready in 15s)")
    }

    const line: VoiceLine = {
      sessionId: opts.sessionId,
      guildId: opts.guildId,
      voiceChannelId: opts.voiceChannelId,
      textChannelId: opts.textChannelId,
      userId: opts.userId,
      connection,
      player,
      capture: null as unknown as CaptureLoop,
      lastAudioAt: Date.now(),
      playingSince: null,
    }

    const capture = new CaptureLoop({
      connection,
      userId: opts.userId,
      stt: this.opts.stt,
      silenceMs: SILENCE_MS,
      vadThreshold: VAD_THRESHOLD,
      vadMinSpeechWindows: VAD_MIN_SPEECH_WINDOWS,
      isPlaying: () => this.isPlaying(opts.guildId),
      onAudioFrame: () => {
        line.lastAudioAt = Date.now()
      },
      onUtterance: (text, lang) => {
        try {
          this.opts.onUtterance({
            sessionId: opts.sessionId,
            guildId: opts.guildId,
            textChannelId: opts.textChannelId,
            voiceChannelId: opts.voiceChannelId,
            userId: opts.userId,
            text,
            lang,
            ts: new Date().toISOString(),
          })
        } catch (err) {
          log.warn('onUtterance dispatch threw:', err)
        }
      },
    })
    line.capture = capture
    this.byGuild.set(opts.guildId, line)
    this.bySession.set(opts.sessionId, opts.guildId)

    capture.start().catch(err => log.warn(`capture.start failed: ${(err as Error).message}`))

    player.on('stateChange', (_old, next) => {
      if (next.status === AudioPlayerStatus.Playing) {
        line.playingSince = Date.now()
      } else if (next.status === AudioPlayerStatus.Idle) {
        line.playingSince = null
      }
    })

    return line
  }

  leave(guildId: string): boolean {
    const line = this.byGuild.get(guildId)
    if (!line) return false
    log.info(`leaving guild=${guildId} (session=${line.sessionId.slice(0, 8)})`)
    try { line.capture.stop() } catch { /* ignore */ }
    try { line.player.stop(true) } catch { /* ignore */ }
    try { line.connection.destroy() } catch { /* ignore */ }
    this.byGuild.delete(guildId)
    this.bySession.delete(line.sessionId)
    return true
  }

  leaveBySession(sessionId: string): boolean {
    const guildId = this.bySession.get(sessionId)
    if (!guildId) return false
    return this.leave(guildId)
  }

  async speak(guildId: string, text: string, speakOpts?: SpeakOpts): Promise<boolean> {
    const line = this.byGuild.get(guildId)
    if (!line) return false
    try {
      await synthesizeAndPlay({ player: line.player, tts: this.opts.tts }, text, speakOpts)
      await whenIdle(line.player)
      return true
    } catch (err) {
      log.warn(`speak failed (guild=${guildId}):`, err)
      return false
    }
  }

  shutdown(): void {
    for (const guildId of [...this.byGuild.keys()]) this.leave(guildId)
  }
}
