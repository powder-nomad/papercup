/**
 * Wrap raw signed-16-bit mono PCM in a WAV file header.
 *
 * Kokoro outputs s16 mono at 24 kHz. OpenClaw's SpeechSynthesisResult expects
 * a fully-formed audio file in a Buffer (the channel adapter then routes it
 * to the platform's audio output — Discord, Slack huddle, etc.).
 */

const HEADER_SIZE = 44;

export function writeWav24kMonoToBuffer(
  pcm: Int16Array,
  sampleRate: number,
  channels: number = 1,
): Buffer {
  const bytesPerSample = 2;
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;
  const dataSize = pcm.length * bytesPerSample;
  const fileSize = HEADER_SIZE + dataSize - 8;

  const buf = Buffer.alloc(HEADER_SIZE + dataSize);
  // RIFF header
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(fileSize, 4);
  buf.write("WAVE", 8, "ascii");
  // fmt subchunk
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);          // PCM fmt subchunk size
  buf.writeUInt16LE(1, 20);           // audio format = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);          // bits per sample
  // data subchunk
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);

  // Copy PCM samples
  const view = new DataView(buf.buffer, buf.byteOffset + HEADER_SIZE, dataSize);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i] ?? 0, true);

  return buf;
}
