import { readFileSync } from "node:fs";

/** The CLI's own version, from package.json (one level up from src/ and dist/ alike). */
export const CLI_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();
