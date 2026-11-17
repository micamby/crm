import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { CliError, EXIT } from "./errors.js";

/**
 * Saved connections ("remotes"). The file holds API keys, so it is created owner-only (0600 in a
 * 0700 directory), written atomically, and refused when anyone else could read it.
 */

export interface Remote {
  url: string;
  /** The API key. Absent after `crm auth logout`. */
  key?: string;
  /** Set at login with --insecure-http: plain http to a host other than localhost. */
  insecure_http?: boolean;
  workspace?: string;
}

export interface Config {
  current?: string;
  remotes: Record<string, Remote>;
}

export const CONFIG_FILE = "config.json";
const isPosix = () => process.platform !== "win32";

export function configPath(dir: string): string {
  return join(dir, CONFIG_FILE);
}

/** Reads the config, refusing a file that is group/world accessible or owned by someone else. */
export function readConfig(dir: string): Config {
  const file = configPath(dir);
  if (!existsSync(file)) return { remotes: {} };
  if (isPosix()) {
    const st = statSync(file);
    if ((st.mode & 0o077) !== 0) {
      throw new CliError("config_insecure",
        `${file} can be read by other users (mode ${(st.mode & 0o777).toString(8)}). It holds API keys: run chmod 600 "${file}", and consider rotating the keys in it`,
        EXIT.failure);
    }
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new CliError("config_insecure", `${file} belongs to another user; refusing to use it`, EXIT.failure);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new CliError("config_invalid", `${file} is not valid JSON; fix or delete it`);
  }
  const c = parsed as Partial<Config>;
  if (!c || typeof c !== "object" || typeof c.remotes !== "object" || c.remotes === null) throw new CliError("config_invalid", `${file} has no "remotes" object`);
  return { current: typeof c.current === "string" ? c.current : undefined, remotes: c.remotes };
}

/** Writes the config: a new 0600 file renamed over the old one, in a 0700 directory. */
export function writeConfig(dir: string, config: Config): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (isPosix()) chmodSync(dir, 0o700);
  const file = configPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(config, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }
}

/** The safe-to-show part of a key: its environment and the first four characters of its lookup ID, as the API shows it. */
export function keyHint(key: string | undefined): string {
  const m = key ? /^(hlcrm_(?:live|test)_)([0-9A-Za-z]{4})/.exec(key) : null;
  return m ? `${m[1]}${m[2]}…` : key ? "(unrecognized key)" : "(none)";
}

export const KEY_PATTERN = /^hlcrm_(live|test)_[0-9A-Za-z]{52}$/;
export const REMOTE_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
