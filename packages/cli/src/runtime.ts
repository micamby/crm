import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Everything the CLI touches outside itself. main.ts builds the real one; tests build one with
 * in-memory streams, a temporary config directory and a fetch that calls the API in-process.
 */
export interface Runtime {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  readStdin: () => Promise<string>;
  /** Reads a line without echoing it (for API keys). Only called when `interactive`. */
  promptSecret: (question: string) => Promise<string>;
  /** Asks a yes/no question on the terminal. Only called when `interactive`. */
  confirm: (question: string) => Promise<boolean>;
  env: Record<string, string | undefined>;
  /** True when stdin and stderr are terminals, so the CLI may ask questions. */
  interactive: boolean;
  /** True when stdout is a terminal (colour, tables). */
  stdoutIsTTY: boolean;
  cwd: string;
  fetch?: typeof fetch;
}

/**
 * Where saved remotes live: $HLCRM_CONFIG_DIR, else $XDG_CONFIG_HOME/hl-crm-db, else
 * ~/.config/hl-crm-db (on macOS too, like most developer CLIs), or %APPDATA%\hl-crm-db on Windows.
 */
export function configDir(env: Runtime["env"], platform = process.platform, home = homedir()): string {
  if (env.HLCRM_CONFIG_DIR) return env.HLCRM_CONFIG_DIR;
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "hl-crm-db");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "hl-crm-db");
}
