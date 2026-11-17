import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { config } from "../config.js";

/**
 * Write-once blob storage for audit anchors and exports. Self-hosted deployments use a local
 * directory (or any S3-compatible store); the hosted service uses S3 with Object Lock.
 */
export interface BlobStore {
  readonly name: string;
  putOnce(key: string, body: string): Promise<string>;
  get(key: string): Promise<string | null>;
  /** Keys directly under a prefix ending in "/", sorted. Verification uses it to find anchors the database has lost. */
  list(prefix: string): Promise<string[]>;
}

export class LocalBlobStore implements BlobStore {
  readonly name = "local";
  constructor(private readonly root = resolve(config().BLOB_DIR)) {}

  private path(key: string): string {
    if (!/^[a-z0-9_\-/.]+$/i.test(key) || key.includes("..")) throw new Error("invalid blob key");
    return join(this.root, key);
  }

  async putOnce(key: string, body: string): Promise<string> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body, { flag: "wx" }); // fails if it already exists: never overwritten
    return `file://${p}`;
  }

  async get(key: string): Promise<string | null> {
    try {
      return await readFile(this.path(key), "utf8");
    } catch {
      return null;
    }
  }

  async list(prefix: string): Promise<string[]> {
    if (!prefix.endsWith("/")) throw new Error("blob prefix must end in /");
    try {
      const entries = await readdir(this.path(prefix), { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => `${prefix}${e.name}`).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; // nothing anchored yet
      throw e;
    }
  }
}

let store: BlobStore | undefined;
export const blobStore = (): BlobStore => (store ??= new LocalBlobStore());
export const setBlobStore = (s: BlobStore): void => {
  store = s;
};
