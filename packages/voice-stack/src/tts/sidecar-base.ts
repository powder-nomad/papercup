import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TtsEngine, SynthesisResult } from "./index.js";

type Pending = {
  resolve: (r: SynthesisResult) => void;
  reject: (err: Error) => void;
};

/**
 * Shared base for TTS engines that talk to a Python sidecar via the
 * Papercup framed-stdio protocol:
 *
 *   request:  [u32 id, u32 textLen][utf8 text]
 *   response: [u32 id, u32 flags, u32 nSamples, u32 sampleRate][s16le pcm][json line]
 *
 * Subclasses just specify the sidecar script name and a log tag.
 */
export abstract class StdioFramedTtsSidecar implements TtsEngine {
  private proc?: ChildProcessWithoutNullStreams;
  private reqId = 0;
  private pending = new Map<number, Pending>();
  private stdoutBuf: Buffer = Buffer.alloc(0);
  private mode: "header" | "pcm" | "json" = "header";
  private currentHeader?: { id: number; ok: boolean; nSamples: number; sampleRate: number };
  private currentPcm?: Int16Array;

  /** Filename inside `voice-stack/sidecar/`, e.g. `tts_kokoro.py`. */
  protected abstract readonly scriptName: string;
  /** Short tag used in log lines, e.g. `tts:kokoro`. */
  protected abstract readonly tag: string;
  /** Optional env vars layered on top of process.env when spawning. */
  protected extraEnv(): NodeJS.ProcessEnv {
    return {};
  }

  async start(): Promise<void> {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const py = process.env.PYTHON ?? path.join(root, "sidecar", ".venv", "bin", "python");
    const script = path.join(root, "sidecar", this.scriptName);

    console.log(`[${this.tag}] spawning ${py} ${script}`);
    this.proc = spawn(py, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.extraEnv() },
      cwd: root,
    });
    this.proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    this.proc.on("exit", (code, sig) => {
      console.error(`[${this.tag}] sidecar exited code=${code} signal=${sig}`);
      this.proc = undefined;
      for (const p of this.pending.values()) {
        p.reject(new Error(`${this.tag} sidecar exited`));
      }
      this.pending.clear();
    });

    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer): void => {
        const idx = chunk.indexOf(0x0a); // newline
        if (idx >= 0 && chunk.subarray(0, idx).toString() === "READY") {
          this.stdoutBuf = chunk.subarray(idx + 1);
          this.proc?.stdout.off("data", onData);
          resolve();
        }
      };
      this.proc!.stdout.on("data", onData);
      this.proc!.on("exit", () => reject(new Error(`${this.tag} sidecar exited before ready`)));
    });
    console.log(`[${this.tag}] sidecar ready`);
  }

  async synthesize(text: string): Promise<SynthesisResult> {
    if (!this.proc) throw new Error(`${this.tag}: start() not called or sidecar dead`);
    const id = ++this.reqId;
    const textBuf = Buffer.from(text, "utf8");
    const header = Buffer.alloc(8);
    header.writeUInt32BE(id, 0);
    header.writeUInt32BE(textBuf.length, 4);

    const result = new Promise<SynthesisResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.proc.stdin.write(header);
    this.proc.stdin.write(textBuf);
    return result;
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf = Buffer.concat([this.stdoutBuf, chunk]);
    while (this.tryConsume()) { /* keep going until we can't */ }
  }

  private tryConsume(): boolean {
    if (this.mode === "header") {
      if (this.stdoutBuf.length < 16) return false;
      const id = this.stdoutBuf.readUInt32BE(0);
      const flags = this.stdoutBuf.readUInt32BE(4);
      const nSamples = this.stdoutBuf.readUInt32BE(8);
      const sampleRate = this.stdoutBuf.readUInt32BE(12);
      this.currentHeader = { id, ok: (flags & 1) === 1, nSamples, sampleRate };
      this.stdoutBuf = this.stdoutBuf.subarray(16);
      this.mode = this.currentHeader.ok && nSamples > 0 ? "pcm" : "json";
      return true;
    }
    if (this.mode === "pcm") {
      const need = (this.currentHeader?.nSamples ?? 0) * 2;
      if (this.stdoutBuf.length < need) return false;
      const pcmBytes = this.stdoutBuf.subarray(0, need);
      const i16 = new Int16Array(pcmBytes.byteLength / 2);
      const dv = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
      for (let i = 0; i < i16.length; i++) i16[i] = dv.getInt16(i * 2, true);
      this.currentPcm = i16;
      this.stdoutBuf = this.stdoutBuf.subarray(need);
      this.mode = "json";
      return true;
    }
    // json
    const nl = this.stdoutBuf.indexOf(0x0a);
    if (nl < 0) return false;
    const line = this.stdoutBuf.subarray(0, nl).toString("utf8").trim();
    this.stdoutBuf = this.stdoutBuf.subarray(nl + 1);
    const header = this.currentHeader;
    const pcm = this.currentPcm ?? new Int16Array(0);
    this.mode = "header";
    this.currentHeader = undefined;
    this.currentPcm = undefined;

    if (!header || line.length === 0) return true;
    const meta = (() => {
      try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; }
    })();
    const id = (meta.id as number | undefined) ?? header.id;
    const slot = this.pending.get(id);
    if (!slot) {
      console.error(`[${this.tag}] orphan response id=${id}`);
      return true;
    }
    this.pending.delete(id);
    if (!header.ok) {
      slot.reject(new Error(`${this.tag} failed: ${(meta.error as string) ?? "unknown"}`));
      return true;
    }
    const durationMs = (pcm.length / header.sampleRate) * 1000;
    console.log(
      `[${this.tag}] req ${id}: ${pcm.length} samples @ ${header.sampleRate}Hz ` +
      `(${durationMs.toFixed(0)}ms audio in ${meta.elapsed ?? "?"}s, RTF=${meta.rtf ?? "?"})`,
    );
    slot.resolve({ pcm, sampleRate: header.sampleRate, durationMs });
    return true;
  }

  stop(): void {
    this.proc?.stdin.end();
    this.proc?.kill();
  }
}
