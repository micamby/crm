import { readFileSync } from "node:fs";

/** The server package version, read once from package.json (two levels up from src/lib and dist/lib alike). */
export const SERVER_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();
