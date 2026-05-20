/**
 * Whisper STT sidecar boot helper.
 *
 * The Python sidecar (packages/voice-stack/sidecar/stt.py) is slow to start —
 * ~5-10s while the model loads. Boot it once at dispatcher startup so the
 * first /voice-join doesn't pay the cold-start tax.
 *
 * Returns null when the sidecar can't be started; callers should treat voice
 * as unavailable in that case rather than crashing the dispatcher (the rest of
 * the channels stack — text, bindings, permission relay — keeps working).
 */

import { WhisperSidecar } from '@papercup/voice-stack/stt'
import { makeLogger } from '../log.ts'

const log = makeLogger('voice:stt')

export async function bootWhisperSidecar(): Promise<WhisperSidecar | null> {
  const stt = new WhisperSidecar()
  try {
    await stt.start()
    log.info('whisper sidecar online')
    return stt
  } catch (err) {
    log.warn(
      'whisper sidecar failed to start — voice will be unavailable. ' +
      'Ensure packages/voice-stack/sidecar/.venv exists (`npm run setup-venv` at repo root). err:',
      err,
    )
    return null
  }
}
