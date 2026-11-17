import { randomBytes } from "node:crypto";
import type { Tx } from "../db/pool.js";
import { open, seal } from "../lib/crypto.js";
import { keyProvider } from "../providers/keys.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { key: Buffer; version: number; expires: number }>();

/** Creates the tenant's first data key. Called once, when the workspace is created. */
export async function createTenantKey(tx: Tx, tenantId: string): Promise<void> {
  const dek = randomBytes(32);
  const wrapped = await keyProvider().wrap(tenantId, dek);
  await tx`INSERT INTO tenant_keys (tenant_id, version, provider, wrapped_key) VALUES (${tenantId}, 1, ${keyProvider().name}, ${wrapped})`;
}

async function currentKey(tx: Tx, tenantId: string): Promise<{ key: Buffer; version: number }> {
  const hit = cache.get(tenantId);
  if (hit && hit.expires > Date.now()) return hit;
  const [row] = await tx<{ version: number; wrapped_key: Buffer }[]>`
    SELECT version, wrapped_key FROM tenant_keys WHERE retired_at IS NULL ORDER BY version DESC LIMIT 1`;
  if (!row) throw new Error("tenant has no data key");
  const key = await keyProvider().unwrap(tenantId, row.wrapped_key);
  const entry = { key, version: row.version, expires: Date.now() + CACHE_TTL_MS };
  cache.set(tenantId, entry);
  return entry;
}

/** Encrypts one restricted field value. AAD binds it to its tenant, record and field. */
export async function encryptValue(tx: Tx, tenantId: string, recordId: string, storageKey: string, value: unknown): Promise<string> {
  const { key, version } = await currentKey(tx, tenantId);
  const sealed = seal(key, Buffer.from(JSON.stringify(value)), `${tenantId}|${recordId}|${storageKey}`);
  return `v${version}:${sealed.toString("base64")}`;
}

export async function decryptValue(tx: Tx, tenantId: string, recordId: string, storageKey: string, stored: string): Promise<unknown> {
  const m = /^v(\d+):(.+)$/.exec(stored);
  if (!m) throw new Error("malformed ciphertext");
  const { key, version } = await currentKey(tx, tenantId);
  if (Number(m[1]) !== version) throw new Error("ciphertext uses a retired key version; re-encryption pending");
  const plain = open(key, Buffer.from(m[2]!, "base64"), `${tenantId}|${recordId}|${storageKey}`);
  return JSON.parse(plain.toString("utf8"));
}
