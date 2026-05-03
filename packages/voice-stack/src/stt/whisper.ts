import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

export type Transcript = {
  id: number;
  text: string;
  lang: string | null;
  duration: number;
  elapsed: number;
  rtf: number;
};

/**
 * Long-lived Python Whisper sidecar. One subprocess per bot. Send raw float32
 * mono 16 kHz PCM, get transcripts back. See sidecar/stt.py for the framing.
 */
export class WhisperSidecar {
  private proc?: ChildProcessWithoutNullStreams;
  private reqId = 0;
  private pending = new Map<number, (r: Transcript) => void>();
  private stdoutBuf = "";
  private readyPromise?: Promise<void>;

  async start(): Promise<void> {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
    const py = process.env.PYTHON ?? path.join(root, "sidecar", ".venv", "bin", "python");
    const script = path.join(root, "sidecar", "stt.py");

    console.log(`[stt] spawning ${py} ${script}`);
    this.proc = spawn(py, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    this.proc.on("exit", (code, sig) => {
      console.error(`[stt] sidecar exited code=${code} signal=${sig}`);
      this.proc = undefined;
      // Fail any pending requests so callers don't hang forever.
      for (const [id, cb] of this.pending) {
        cb({ id, text: "", lang: null, duration: 0, elapsed: 0, rtf: 0 });
      }
      this.pending.clear();
    });

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const onChunk = (s: string): void => {
        if (s.includes("READY")) {
          // Strip the READY line out of the buffer so it isn't parsed as JSON.
          this.stdoutBuf = this.stdoutBuf.replace(/^READY\r?\n/m, "");
          resolve();
          this.proc?.stdout.off("data", onChunk);
        }
      };
      this.proc!.stdout.on("data", onChunk);
      this.proc!.on("exit", () => reject(new Error("sidecar exited before ready")));
    });

    await this.readyPromise;
    console.log("[stt] sidecar ready");
  }

  async transcribe(mono16k: Float32Array): Promise<Transcript> {
    if (!this.proc) throw new Error("WhisperSidecar: start() not called or sidecar dead");
    const id = ++this.reqId;
    const header = Buffer.alloc(8);
    header.writeUInt32BE(id, 0);
    header.writeUInt32BE(mono16k.length, 4);
    const audioBuf = Buffer.from(mono16k.buffer, mono16k.byteOffset, mono16k.byteLength);

    const result = new Promise<Transcript>((resolve) => {
      this.pending.set(id, resolve);
    });
    this.proc.stdin.write(header);
    this.proc.stdin.write(audioBuf);
    return result;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.length === 0 || line === "READY") continue;
      try {
        const r = JSON.parse(line) as Transcript;
        const cb = this.pending.get(r.id);
        if (cb) {
          this.pending.delete(r.id);
          cb(r);
        } else {
          console.error(`[stt] orphan response id=${r.id}`);
        }
      } catch {
        console.error(`[stt] bad json: ${line}`);
      }
    }
  }

  stop(): void {
    this.proc?.stdin.end();
    this.proc?.kill();
  }
}
