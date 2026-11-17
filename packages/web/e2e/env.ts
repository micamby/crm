import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Paths and settings shared by setup, teardown and tests. Database URLs are built like the server's tests build theirs (from the root .env). */
export const ROOT = join(HERE, "..", "..", "..");
export const SERVER = join(ROOT, "packages", "server");
export const PORT = Number(process.env.E2E_PORT ?? 8791);
/** One state file per port, so two runs on different ports (E2E_PORT) don't overwrite each other's. */
export const STATE = join(HERE, PORT === 8791 ? ".state.json" : `.state-${PORT}.json`);
export const ORIGIN = `http://localhost:${PORT}`;
/** OAuth for MCP is on in the end-to-end API (the consent flow is tested): MCP_PUBLIC_URL only names the MCP endpoints, no MCP process runs. */
export const MCP_ORIGIN = `http://localhost:${PORT + 1}`;
const serviceSecret = process.env.E2E_MCP_SERVICE_SECRET ?? randomBytes(32).toString("base64url");

function dotenv(): Record<string, string> {
  try {
    return Object.fromEntries(readFileSync(join(ROOT, ".env"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  } catch {
    return {};
  }
}

/** The environment the server CLI and API run with: the E2E database (never hlcrm or hlcrm_test), people sign-in on localhost. */
export function serverEnv(): NodeJS.ProcessEnv {
  const env = dotenv();
  const host = process.env.E2E_DB_HOST ?? "127.0.0.1:5433";
  const db = process.env.E2E_DB_NAME ?? "hlcrm_dev_web";
  if (db === "hlcrm" || db === "hlcrm_test") throw new Error(`Refusing to run end-to-end tests against ${db}`);
  return {
    ...process.env,
    NODE_ENV: "production",
    LOG_LEVEL: "warn",
    DATABASE_URL: process.env.E2E_DATABASE_URL ?? `postgres://hlcrm_app:${env.HLCRM_APP_PASSWORD ?? ""}@${host}/${db}`,
    MIGRATOR_DATABASE_URL: process.env.E2E_MIGRATOR_URL ?? `postgres://hlcrm_migrator:${env.HLCRM_MIGRATOR_PASSWORD ?? ""}@${host}/${db}`,
    HLCRM_MASTER_KEY: process.env.HLCRM_MASTER_KEY ?? env.HLCRM_MASTER_KEY,
    PUBLIC_URL: ORIGIN,
    API_PORT: String(PORT),
    WEB_UI: "true",
    MCP_PUBLIC_URL: MCP_ORIGIN,
    MCP_SERVICE_SECRET: serviceSecret,
    WEB_UI_DIR: join(ROOT, "packages", "web", "dist"),
  };
}

/** Runs a server CLI command (migrate, bootstrap, sign-in-link) and returns its stdout. */
export function serverCli(args: string[]): string {
  return execFileSync(join(SERVER, "node_modules", ".bin", "tsx"), ["src/cli.ts", ...args], { cwd: SERVER, env: serverEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export interface E2EState {
  workspace: string;
  owner: string;
  limited: string;
  pid: number;
  adminKey: string;
  ids: Record<string, string>;
}

export const readState = (): E2EState => JSON.parse(readFileSync(STATE, "utf8")) as E2EState;
