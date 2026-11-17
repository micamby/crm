import { writeFileSync } from "node:fs";
import { ORIGIN, readState, STATE } from "./env";

/**
 * Revokes the fixture's admin key (it was only needed to set the workspace up) and stops the API started
 * by the setup. Nothing else is archived: the E2E workspace stays in the database (each run makes its own).
 */
export default async function teardown() {
  let state: ReturnType<typeof readState> | null = null;
  try {
    state = readState();
  } catch {
    return;
  }
  if (state.adminKey) {
    try {
      const auth = { Authorization: `Bearer ${state.adminKey}`, "Content-Type": "application/json" };
      const keys = (await (await fetch(`${ORIGIN}/v1/api-keys`, { headers: auth })).json()) as { data: { id: string; hint: string; revoked_at: string | null }[] };
      const mine = keys.data.find((k) => !k.revoked_at && state.adminKey.startsWith(k.hint.replace(/…$/, "")));
      if (mine) {
        const r = await fetch(`${ORIGIN}/v1/api-keys/${encodeURIComponent(mine.id)}/revoke`, { method: "POST", headers: auth, body: "{}" });
        if (!r.ok) console.warn(`Couldn't revoke the E2E admin key: ${r.status}`);
      }
    } catch (e) {
      console.warn(`Couldn't revoke the E2E admin key: ${(e as Error).message}`);
    }
    // The key is dead either way; don't leave it on disk.
    writeFileSync(STATE, JSON.stringify({ ...state, adminKey: "" }));
  }
  try {
    process.kill(state.pid);
  } catch {
    // Already gone.
  }
}
