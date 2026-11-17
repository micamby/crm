import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/** Integration tests need the local Compose Postgres (port 5433) or TEST_* URLs, as in CI. */
function localEnv(): Record<string, string> {
  try {
    return Object.fromEntries(readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  } catch {
    return {};
  }
}

const env = localEnv();
const host = process.env.TEST_DB_HOST ?? "127.0.0.1:5433";
const name = process.env.TEST_DB_NAME ?? "hlcrm_test"; // set this to run suites side by side against separate databases
process.env.TEST_DATABASE_URL ??= `postgres://hlcrm_app:${env.HLCRM_APP_PASSWORD ?? ""}@${host}/${name}`;
process.env.TEST_MIGRATOR_URL ??= `postgres://hlcrm_migrator:${env.HLCRM_MIGRATOR_PASSWORD ?? ""}@${host}/${name}`;

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/env.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
