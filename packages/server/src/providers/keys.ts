import { masterKey } from "../config.js";
import { open, seal } from "../lib/crypto.js";

/**
 * Wraps and unwraps tenant data keys. Self-hosted deployments use a local master key;
 * the hosted service plugs in AWS KMS behind the same interface.
 */
export interface KeyProvider {
  readonly name: string;
  wrap(tenantId: string, dek: Buffer): Promise<Buffer>;
  unwrap(tenantId: string, wrapped: Buffer): Promise<Buffer>;
}

export class LocalKeyProvider implements KeyProvider {
  readonly name = "local";
  async wrap(tenantId: string, dek: Buffer): Promise<Buffer> {
    return seal(masterKey(), dek, `tenant-dek:${tenantId}`);
  }
  async unwrap(tenantId: string, wrapped: Buffer): Promise<Buffer> {
    return open(masterKey(), wrapped, `tenant-dek:${tenantId}`);
  }
}

let provider: KeyProvider = new LocalKeyProvider();
export const keyProvider = (): KeyProvider => provider;
export const setKeyProvider = (p: KeyProvider): void => {
  provider = p;
};
