import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256 = (data: string | Buffer): Buffer => createHash("sha256").update(data).digest();
export const hmac = (key: Buffer, data: string): string => createHmac("sha256", key).update(data).digest("base64url");

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** AES-256-GCM. Output layout: 12-byte IV | 16-byte tag | ciphertext. */
export function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function open(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < 28) throw new Error("ciphertext is too short");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
}

/** Canonical JSON (sorted keys) so hashes are stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
