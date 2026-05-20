/**
 * Voice-capture loop for one VoiceLine.
 *
 * Ported (with simplifications) from packages/bot/src/index.ts `beginCaptureLoop` +
 * `handleUtterance` + `runAgent`. The capture flow:
 *
 *   receiver.subscribe(userId, AfterSilence) → opus stream
 *     ↳ prism.opus.Decoder → 48k stereo s16 PCM chunks
 *     ↳ on stream end → handleUtterance(concat) →
 *         stereo48kS16ToMono16kF32 → SileroVad windowed score
 *         (skip if speech-window count below threshold)
 *         → WhisperSidecar.transcribe → fire onUtterance(text, lang)
 *     ↳ re-subscribe for the next utterance
 *
 * Echo suppression: while `isPlaying()` is true, the utterance is dropped
 * instead of transcribed, so the bot doesn't hear its own TTS playback.
 */

import { EndBehaviorType, VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice'
import prism from 'prism-media'
import { SileroVad } from '@papercup/voice-stack/vad'
import type { WhisperSidecar } from '@papercup/voice-stack/stt'
import { stereo48kS16ToMono16kF32 } from '@papercup/voice-stack/audio'
import { makeLogger } from '../log.ts'

const log = makeLogger('voice:capture')

const VAD_WINDOW_SAMPLES = 512 // 32ms @ 16kHz mono

export type CaptureOpts = {
  connection: VoiceConnection
  userId: string
  stt: WhisperSidecar
  /** ms of trailing silence that ends an utterance. Mirrors SILENCE_MS in the bot. */
  silenceMs: number
  /** VAD speech-probability threshold per 32ms window. */
  vadThreshold: number
  /** Minimum number of speech windows for an utterance to be transcribed. */
  vadMinSpeechWindows: number
  /** While this returns true, skip VAD / STT to avoid transcribing the bot's own TTS playback. */
  isPlaying: () => boolean
  /** Called on every speech utterance with a non-empty transcript. */
  onUtterance: (text: string, lang: string | null) => void
  /** Called every time an opus frame arrives. Used for the heartbeat / idle-reaper bypass. */
  onAudioFrame?: () => void
}

export class CaptureLoop {
  private vad = new SileroVad()
  private ready = false
  private stopped = false

  constructor(private opts: CaptureOpts) {}

  async start(): Promise<void> {
    await this.vad.load()
    this.ready = true
    this.scheduleOnce()
  }

  stop(): void {
    this.stopped = true
  }

  private scheduleOnce(): void {
    if (this.stopped || !this.ready) return
    setImmediate(() => this.captureOnce())
  }

  private captureOnce(): void {
    const { connection, userId, silenceMs } = this.opts
    if (this.stopped) return
    if (connection.state.status === VoiceConnectionStatus.Destroyed) {
      log.info('connection destroyed; capture loop exit')
      return
    }
    const opusStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: silenceMs },
    })
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 })
    const pcmChunks: Buffer[] = []
    let opusFrames = 0
    let restarted = false
    const restart = (reason: string): void => {
      if (restarted) return
      restarted = true
      log.info(`restart (${reason})`)
      try { opusStream.destroy() } catch { /* already gone */ }
      this.scheduleOnce()
    }

    opusStream.on('data', () => {
      opusFrames++
      this.opts.onAudioFrame?.()
    })

    const pcmStream = opusStream.pipe(decoder)
    pcmStream.on('data', (chunk: Buffer) => {
      pcmChunks.push(chunk)
    })
    pcmStream.once('end', () => {
      if (restarted) return
      restarted = true
      const buf = Buffer.concat(pcmChunks)
      this.handleUtterance(buf, opusFrames).finally(() => this.scheduleOnce())
    })
    pcmStream.once('error', err => {
      log.warn('pcm stream error:', err)
      restart('pcm-error')
    })
    opusStream.once('error', err => {
      log.warn('opus stream error:', err)
      restart('opus-error')
    })
  }

  private async handleUtterance(pcm48kStereoS16: Buffer, opusFrames: number): Promise<void> {
    if (pcm48kStereoS16.length === 0) return
    if (this.opts.isPlaying()) {
      log.info(`skip (playback active): ${opusFrames} opus frames`)
      return
    }

    const mono16k = stereo48kS16ToMono16kF32(pcm48kStereoS16)
    const windows = Math.floor(mono16k.length / VAD_WINDOW_SAMPLES)
    let speechWindows = 0
    let maxProb = 0
    for (let i = 0; i < windows; i++) {
      const slice = new Float32Array(
        mono16k.subarray(i * VAD_WINDOW_SAMPLES, (i + 1) * VAD_WINDOW_SAMPLES),
      )
      const p = await this.vad.run(slice)
      if (p > maxProb) maxProb = p
      if (p >= this.opts.vadThreshold) speechWindows++
    }

    if (speechWindows < this.opts.vadMinSpeechWindows) {
      log.info(
        `noise-only: ${opusFrames} opus frames, ${windows} windows, max=${maxProb.toFixed(2)}`,
      )
      return
    }

    let transcript
    try {
      transcript = await this.opts.stt.transcribe(mono16k)
    } catch (err) {
      log.warn('stt failed:', err)
      return
    }
    const text = (transcript.text ?? '').trim()
    if (!text) {
      log.info('transcript empty — skipping')
      return
    }
    log.info(
      `utterance: "${text}" (${transcript.duration ?? 0}s, RTF=${transcript.rtf ?? 0}, lang=${transcript.lang ?? '?'})`,
    )
    try {
      this.opts.onUtterance(text, transcript.lang ?? null)
    } catch (err) {
      log.warn('onUtterance handler threw:', err)
    }
  }
}
