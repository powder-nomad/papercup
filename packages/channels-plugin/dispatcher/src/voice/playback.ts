/**
 * TTS playback for one VoiceLine.
 *
 * Mirrors packages/bot/src/index.ts `playBack` + the synth call in `runAgent`.
 * The bot pushes raw 48 kHz stereo s16 PCM into `createAudioResource(..., {
 * inputType: StreamType.Raw })` — discord.js handles opus encoding under the
 * hood, so no explicit @discordjs/opus call is needed here.
 *
 * The TTS engine is a long-lived sidecar managed by the VoiceService — we
 * just borrow it.
 */

import {
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  type AudioPlayer,
} from '@discordjs/voice'
import { Readable } from 'node:stream'
import type { TtsEngine } from '@papercup/voice-stack/tts'
import { mono24kS16ToStereo48kS16 } from '@papercup/voice-stack/audio'
import { makeLogger } from '../log.ts'

const log = makeLogger('voice:playback')

const MAX_SPEECH_CHARS = 600

export type PlaybackOpts = {
  player: AudioPlayer
  tts: TtsEngine
}

export type SpeakOpts = {
  lang?: string
}

export async function synthesizeAndPlay(
  opts: PlaybackOpts,
  text: string,
  speakOpts?: SpeakOpts,
): Promise<void> {
  const clean = text.trim()
  if (!clean) return

  const speech = truncateForSpeech(clean, MAX_SPEECH_CHARS)
  const synthStart = Date.now()
  const synth = await opts.tts.synthesize(speech, speakOpts)
  const synthMs = Date.now() - synthStart
  const stereo48k = mono24kS16ToStereo48kS16(synth.pcm)
  const resource = createAudioResource(Readable.from(stereo48k), {
    inputType: StreamType.Raw,
  })
  opts.player.play(resource)
  log.info(
    `synth=${synthMs}ms audio=${synth.durationMs.toFixed(0)}ms (RTF=${(synthMs / Math.max(1, synth.durationMs)).toFixed(2)}) — playing`,
  )
}

/**
 * Wait until the audio player is finished playing (status returns to Idle).
 * Resolves immediately if already idle.
 */
export function whenIdle(player: AudioPlayer, timeoutMs = 60_000): Promise<void> {
  if (player.state.status === AudioPlayerStatus.Idle) return Promise.resolve()
  return new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      player.off('stateChange', onState)
      resolve()
    }, timeoutMs)
    const onState = (
      _old: { status: AudioPlayerStatus },
      next: { status: AudioPlayerStatus },
    ): void => {
      if (next.status === AudioPlayerStatus.Idle) {
        clearTimeout(timer)
        player.off('stateChange', onState)
        resolve()
      }
    }
    player.on('stateChange', onState)
  })
}

function truncateForSpeech(text: string, max: number): string {
  if (text.length <= max) return text
  const window = text.slice(0, max)
  const lastPunct = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
  )
  const cut = lastPunct > max / 2 ? lastPunct + 1 : max
  return text.slice(0, cut).trim() + '…'
}
