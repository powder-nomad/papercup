import * as ort from "onnxruntime-node";
import path from "node:path";

const MODEL_PATH = path.join(process.cwd(), "models", "silero_vad.onnx");
const session = await ort.InferenceSession.create(MODEL_PATH);

console.log("inputNames:", session.inputNames);
console.log("outputNames:", session.outputNames);

// Quick test: synthesize a 1 kHz tone at 16 kHz, see if VAD picks it up
const N = 512;
const tone = new Float32Array(N);
for (let i = 0; i < N; i++) tone[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / 16000);

const input = new ort.Tensor("float32", tone, [1, N]);
const state = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
const sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);

console.log("--- run with sr shape [] ---");
try {
  const r = await session.run({ input, state, sr });
  console.log("output keys:", Object.keys(r));
  for (const [k, v] of Object.entries(r)) {
    console.log(`  ${k}: dims=${v.dims}, type=${v.type}, data[0..3]=${Array.from(v.data).slice(0, 3)}`);
  }
} catch (e) {
  console.log("err:", e.message);
}

console.log("--- run with sr shape [1] ---");
try {
  const sr1 = new ort.Tensor("int64", BigInt64Array.from([16000n]), [1]);
  const r = await session.run({ input, state, sr: sr1 });
  console.log("output keys:", Object.keys(r));
  for (const [k, v] of Object.entries(r)) {
    console.log(`  ${k}: dims=${v.dims}, type=${v.type}, data[0..3]=${Array.from(v.data).slice(0, 3)}`);
  }
} catch (e) {
  console.log("err:", e.message);
}

// Also: a louder white-noise burst
console.log("--- noise burst ---");
const noise = new Float32Array(N);
for (let i = 0; i < N; i++) noise[i] = (Math.random() * 2 - 1) * 0.5;
const inputN = new ort.Tensor("float32", noise, [1, N]);
const state2 = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
const sr1 = new ort.Tensor("int64", BigInt64Array.from([16000n]), [1]);
try {
  const r = await session.run({ input: inputN, state: state2, sr: sr1 });
  for (const [k, v] of Object.entries(r)) {
    console.log(`  ${k}: dims=${v.dims}, type=${v.type}, data[0..3]=${Array.from(v.data).slice(0, 3)}`);
  }
} catch (e) {
  console.log("err:", e.message);
}
