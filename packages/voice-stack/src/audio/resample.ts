/**
 * Convert 48 kHz signed-16-bit interleaved stereo PCM (Discord output)
 * into 16 kHz float32 mono PCM (Silero VAD / Whisper input).
 *
 * Strategy: average L+R for each stereo frame, decimate by 3, normalize to [-1, 1].
 * No anti-alias filter — speech-band aliasing from 48→16k is small enough that
 * VAD and Whisper both tolerate it well. Revisit if quality matters.
 */
export function stereo48kS16ToMono16kF32(s16: Buffer): Float32Array {
  // Each stereo frame is 4 bytes (2 ch × s16). Decimate by 3 → take every 3rd frame.
  const stereoFrames = s16.length >>> 2;
  const outLen = Math.floor(stereoFrames / 3);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const frameOffset = i * 3 * 4;
    const left = s16.readInt16LE(frameOffset);
    const right = s16.readInt16LE(frameOffset + 2);
    out[i] = ((left + right) / 2) / 32768;
  }
  return out;
}
