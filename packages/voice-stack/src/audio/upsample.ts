/**
 * Convert mono signed-16-bit PCM at 24 kHz (Kokoro output) into 48 kHz stereo
 * signed-16-bit interleaved PCM (what Discord wants via StreamType.Raw).
 *
 * Strategy: linear interpolation 1×→2× to get to 48 kHz, then duplicate the
 * mono sample to both channels. No anti-aliasing needed when going up.
 */
export function mono24kS16ToStereo48kS16(mono: Int16Array): Buffer {
  const inLen = mono.length;
  const outLen = inLen * 2; // 24k → 48k
  const out = Buffer.alloc(outLen * 4); // stereo s16 = 4 bytes/frame

  for (let i = 0; i < inLen; i++) {
    const a = mono[i] ?? 0;
    const b = mono[i + 1] ?? a;
    const interp = ((a + b) / 2) | 0;
    const o = i * 2 * 4;
    // Frame 1: original sample, both channels
    out.writeInt16LE(a, o);
    out.writeInt16LE(a, o + 2);
    // Frame 2: midpoint, both channels
    out.writeInt16LE(interp, o + 4);
    out.writeInt16LE(interp, o + 6);
  }
  return out;
}
