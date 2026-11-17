import { defineConfig } from "vitest/config";

/** Unit tests only, no database. The tests that drive the CLI against the API live in packages/server/test/cli.test.ts. */
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
