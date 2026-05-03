import * as ort from "onnxruntime-node";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve model path relative to this module so the wrapper works regardless
// of caller cwd. Override with SILERO_VAD_MODEL_PATH if you need a custom one.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODEL_PATH =
  process.env.SILERO_VAD_MODEL_PATH ?? path.join(PACKAGE_ROOT, "models", "silero_vad.onnx");

// At 16 kHz the official Silero wrapper prepends a 64-sample context buffer
// (the last 64 samples of the previous window) to each 512-sample frame, so
// the model actually sees [1, 576]. Without this prefix the model sees
// truncated input and outputs near-zero for everything — including speech.
const CONTEXT_SAMPLES = 64;

/**
 * Silero VAD wrapper. Stateful — keeps the LSTM hidden state AND a 64-sample
 * audio context buffer across calls. Use one instance per logical audio stream
 * (i.e. per call / per user). Reset via `reset()`.
 *
 * Inputs are 16 kHz float32 mono PCM windows of exactly 512 samples (32 ms).
 * Output is the probability of speech in [0, 1].
 */
export class SileroVad {
  private session?: ort.InferenceSession;
  private state: ort.Tensor = new ort.Tensor(
    "float32",
    new Float32Array(2 * 1 * 128),
    [2, 1, 128],
  );
  private context: Float32Array = new Float32Array(CONTEXT_SAMPLES);
  private readonly sampleRate: ort.Tensor = new ort.Tensor(
    "int64",
    BigInt64Array.from([16000n]),
    [],
  );

  async load(): Promise<void> {
    this.session = await ort.InferenceSession.create(MODEL_PATH);
  }

  reset(): void {
    this.state = new ort.Tensor(
      "float32",
      new Float32Array(2 * 1 * 128),
      [2, 1, 128],
    );
    this.context = new Float32Array(CONTEXT_SAMPLES);
  }

  async run(window: Float32Array): Promise<number> {
    if (!this.session) throw new Error("SileroVad: load() not called");
    const total = CONTEXT_SAMPLES + window.length;
    const buf = new Float32Array(total);
    buf.set(this.context, 0);
    buf.set(window, CONTEXT_SAMPLES);

    const input = new ort.Tensor("float32", buf, [1, total]);
    const result = await this.session.run({
      input,
      state: this.state,
      sr: this.sampleRate,
    });
    this.state = result.stateN as ort.Tensor;

    // Save the trailing CONTEXT_SAMPLES of THIS window for the next call.
    this.context = window.slice(window.length - CONTEXT_SAMPLES);

    const output = result.output as ort.Tensor;
    return (output.data as Float32Array)[0] ?? 0;
  }
}
