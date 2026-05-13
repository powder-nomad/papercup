import fs from "node:fs/promises";
import path from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";

const DEFAULT_PATH = path.join(process.cwd(), "data", "bot-identity.json");

interface IdentityFile {
  publicKey: string;
  privateKey: string;
  createdAt: number;
}

/**
 * Per-bot persistent Ed25519 keypair.
 *
 * Generated on first boot, reused thereafter. The public key ships in the
 * roster announcement so other bots can (in a future iteration) verify
 * signed handshakes. The full signing/verification protocol is deferred —
 * for now we just generate and persist the key so the roster entry is
 * complete and the protocol can be built on top without bot-side migration.
 */
export class BotIdentity {
  private publicKey?: string;
  private privateKey?: string;
  private createdAt?: number;
  private file = DEFAULT_PATH;

  async loadOrGenerate(file: string = DEFAULT_PATH): Promise<void> {
    this.file = file;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as IdentityFile;
      if (parsed.publicKey && parsed.privateKey) {
        this.publicKey = parsed.publicKey;
        this.privateKey = parsed.privateKey;
        this.createdAt = parsed.createdAt;
        return;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[bot-identity] load failed (will regenerate): ${(err as Error).message}`);
      }
    }
    this.generate();
    await this.save();
  }

  private generate(): void {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    this.publicKey = publicKey.export({ type: "spki", format: "pem" }).toString();
    this.privateKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    this.createdAt = Date.now();
  }

  private async save(): Promise<void> {
    if (!this.publicKey || !this.privateKey) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const data: IdentityFile = {
      publicKey: this.publicKey,
      privateKey: this.privateKey,
      createdAt: this.createdAt ?? Date.now(),
    };
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, this.file);
    try { await fs.chmod(this.file, 0o600); } catch { /* not critical */ }
  }

  getPublicKey(): string | undefined { return this.publicKey; }

  /**
   * Short fingerprint suitable for roster display: SHA-256 of the public key
   * encoded base64url, truncated to 16 chars. Stable across reboots.
   */
  getFingerprint(): string {
    if (!this.publicKey) return "(no key)";
    const h = createHash("sha256").update(this.publicKey).digest();
    return h.toString("base64url").slice(0, 16);
  }

  /**
   * Compact base64 form of the raw public key (without PEM headers), suitable
   * for embedding in a Discord roster message.
   */
  getPublicKeyBase64(): string {
    if (!this.publicKey) return "";
    return this.publicKey
      .replace(/-----BEGIN PUBLIC KEY-----/g, "")
      .replace(/-----END PUBLIC KEY-----/g, "")
      .replace(/\s+/g, "");
  }
}

export const botIdentity = new BotIdentity();
