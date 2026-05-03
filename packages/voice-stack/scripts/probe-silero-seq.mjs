import * as ort from "onnxruntime-node";
import path from "node:path";
import fs from "node:fs";

const MODEL_PATH = path.join(process.cwd(), "models", "silero_vad.onnx");
const session = await ort.InferenceSession.create(MODEL_PATH);

// Synthesize "speech-like" formant audio: sum of sines at 200, 800, 2400 Hz
// modulated at 5 Hz, plus harmonics. Not real speech, but should excite the
// VAD more than a pure tone.
const SR = 16000;
const N_WINDOWS = 30;
const W = 512;
const total = N_WINDOWS * W;
const audio = new Float32Array(total);
for (let i = 0; i < total; i++) {
  const t = i / SR;
  const env = 0.5 * (1 + Math.sin(2 * Math.PI * 5 * t));
  audio[i] = env * 0.3 * (
    Math.sin(2 * Math.PI * 200 * t) +
    0.6 * Math.sin(2 * Math.PI * 800 * t) +
    0.3 * Math.sin(2 * Math.PI * 2400 * t)
  );
}

let state = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
const sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);

console.log("--- formant-modulated speech-like audio ---");
for (let w = 0; w < N_WINDOWS; w++) {
  const slice = audio.slice(w * W, (w + 1) * W);
  const input = new ort.Tensor("float32", slice, [1, W]);
  const r = await session.run({ input, state, sr });
  const p = r.output.data[0];
  state = r.stateN;
  console.log(`  window ${w}: p=${p.toFixed(6)}`);
}

// And try: dump and replay the very first PCM that production captured.
// We'll just synthesize a fake "voice" with strong low-freq energy
console.log("--- pink noise burst ---");
state = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
for (let w = 0; w < 10; w++) {
  const slice = new Float32Array(W);
  for (let i = 0; i < W; i++) {
    slice[i] = (Math.random() * 2 - 1) * 0.4;
  }
  const input = new ort.Tensor("float32", slice, [1, W]);
  const r = await session.run({ input, state, sr });
  const p = r.output.data[0];
  state = r.stateN;
  console.log(`  window ${w}: p=${p.toFixed(6)}`);
}

// Sanity: try sample rate 8000 — maybe the model wants 8 kHz input?
// (Silero supports both 8 kHz and 16 kHz with different window sizes: 256 vs 512)
console.log("--- check model with sr=8000, window=256 ---");
state = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
const sr8 = new ort.Tensor("int64", BigInt64Array.from([8000n]), []);
for (let w = 0; w < 10; w++) {
  const slice = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const t = (w * 256 + i) / 8000;
    slice[i] = 0.3 * (
      Math.sin(2 * Math.PI * 200 * t) +
      0.6 * Math.sin(2 * Math.PI * 800 * t)
    );
  }
  const input = new ort.Tensor("float32", slice, [1, 256]);
  const r = await session.run({ input, state, sr: sr8 });
  const p = r.output.data[0];
  state = r.stateN;
  console.log(`  window ${w}: p=${p.toFixed(6)}`);
}
