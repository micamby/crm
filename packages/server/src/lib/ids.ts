import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const DECODE = new Map([...ALPHABET].map((c, i) => [c, i]));

/** Generates a UUIDv7 (RFC 9562): 48-bit millisecond timestamp, then random bits. */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toBase32(hex: string): string {
  let n = BigInt(`0x${hex}`);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

function fromBase32(s: string): string | null {
  if (s.length !== 26) return null;
  let n = 0n;
  for (const c of s.toUpperCase()) {
    const v = DECODE.get(c);
    if (v === undefined) return null;
    n = (n << 5n) | BigInt(v);
  }
  if (n >> 128n) return null;
  const hex = n.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Renders a UUID as a prefixed, sortable public ID, e.g. `con_01JB…`. */
export function encodeId(prefix: string, uuid: string): string {
  return `${prefix}_${toBase32(uuid.replaceAll("-", ""))}`;
}

/** Parses a public ID. Returns null for anything malformed. */
export function decodeId(publicId: string): { prefix: string; uuid: string } | null {
  const m = /^([a-z]{2,8}|v)_([0-9A-Za-z]{26})$/.exec(publicId);
  if (!m) return null;
  const uuid = fromBase32(m[2]!);
  return uuid ? { prefix: m[1]!, uuid } : null;
}

export const ID_PREFIX_PATTERN = /^[a-z]{2,8}$/;

/**
 * Saved views (v_…; decodeId takes this one single letter). An object's prefix can never be one letter
 * (ID_PREFIX_PATTERN, and the CHECK on objects.id_prefix since migration 002), so a view ID can't be taken
 * for a record ID in any workspace, including one whose custom object took a prefix before it was reserved.
 */
export const VIEW_ID_PREFIX = "v";
