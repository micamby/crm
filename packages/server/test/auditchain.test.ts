import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { audit } from "../src/core/audit.js";
import { anchorTenant, sealTenant, verifyTenant } from "../src/core/auditchain.js";
import { systemCtx } from "../src/core/context.js";
import { db } from "../src/db/pool.js";
import { withTenant } from "../src/db/tx.js";
import { call, newWorkspace } from "./helpers.js";

/** The migrator (table owner) can switch the guard trigger off: it stands in for someone with direct database access. */
const owner = postgres(process.env.TEST_MIGRATOR_URL!, { max: 1, onnotice: () => {} });
afterAll(() => owner.end());

async function tamper(tenantId: string, fn: (tx: postgres.TransactionSql) => Promise<unknown>) {
  await owner.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    await tx`ALTER TABLE audit_log DISABLE TRIGGER audit_log_guard`;
    await fn(tx);
    await tx`ALTER TABLE audit_log ENABLE TRIGGER audit_log_guard`;
  });
}

const sealAll = async (t: string) => { while ((await sealTenant(t)) > 0) { /* seal everything */ } };
const write = (t: string, action: string) => withTenant(t, (tx) => audit(tx, systemCtx(t, "test"), { action }));

/** A sealed, anchored tenant with a few rows. */
async function sealedTenant(name: string) {
  const ws = await newWorkspace(name);
  for (let i = 0; i < 5; i++) await write(ws.tenantId, `test.row_${i}`);
  await sealAll(ws.tenantId);
  expect(await anchorTenant(ws.tenantId)).toBe(true);
  const v = await verifyTenant(ws.tenantId);
  expect(v, JSON.stringify(v)).toMatchObject({ ok: true, unsealed: 0, anchors_checked: 1, stored_anchors_checked: 1 });
  return ws.tenantId;
}

const positions = (t: string) => withTenant(t, (tx) => tx<{ seq: string; chain_pos: string }[]>`
  SELECT seq::text, chain_pos::text FROM audit_log ORDER BY audit_log.chain_pos`);

describe("audit chain order", () => {
  it("a lower seq that commits after a higher one was sealed joins the chain at the end, and the chain verifies", async () => {
    const ws = await newWorkspace("Chain order");
    const t = ws.tenantId;
    await sealAll(t);
    // A slow transaction takes the lower seq and holds it uncommitted...
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const didInsert = new Promise<void>((r) => (inserted = r));
    const slow = db().begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${t}, true)`;
      await audit(tx, systemCtx(t, "slow"), { action: "test.slow" });
      inserted();
      await held;
    });
    await didInsert;
    // ...while a later one commits a higher seq, which gets sealed.
    await write(t, "test.fast");
    await sealAll(t);
    release();
    await slow;
    await sealAll(t);
    const rows = await withTenant(t, (tx) => tx<{ action: string; seq: string; chain_pos: string }[]>`
      SELECT action, seq::text, chain_pos::text FROM audit_log WHERE action LIKE 'test.%' ORDER BY audit_log.chain_pos`);
    expect(rows.map((r) => r.action)).toEqual(["test.fast", "test.slow"]);
    expect(BigInt(rows[1]!.seq)).toBeLessThan(BigInt(rows[0]!.seq)); // chain order differs from seq order
    expect(await anchorTenant(t)).toBe(true);
    const v = await verifyTenant(t);
    expect(v, JSON.stringify(v)).toMatchObject({ ok: true, unsealed: 0, anchors_checked: 1, stored_anchors_checked: 1 });
    expect(v.checks).toEqual(expect.arrayContaining(["chain_links", "row_hashes", "chain_positions_contiguous", "anchors_in_storage", "storage_anchors_in_database"]));
  });

  it("chain positions are assigned by the database, not the caller", async () => {
    const ws = await newWorkspace("Positions");
    await sealAll(ws.tenantId);
    const ps = (await positions(ws.tenantId)).map((r) => Number(r.chain_pos));
    expect(ps).toEqual(ps.map((_, i) => i + 1));
    // The app role cannot set chain_pos (column grants), and sealed rows stay immutable.
    await expect(withTenant(ws.tenantId, (tx) => tx`UPDATE audit_log SET chain_pos = 99 WHERE audit_log.chain_pos = 1`)).rejects.toThrow();
    await expect(withTenant(ws.tenantId, (tx) => tx`UPDATE audit_log SET hash = NULL WHERE audit_log.chain_pos = 1`)).rejects.toThrow(/immutable/);
  });

  it("the app role can't insert a row that is already sealed", async () => {
    const ws = await newWorkspace("Pre-sealed");
    const t = ws.tenantId;
    const fake = Buffer.alloc(32, 1);
    for (const cols of [
      { chain_pos: 999999999, prev_hash: fake, hash: fake, sealed_at: new Date() },
      { chain_pos: 999999999 }, { hash: fake }, { prev_hash: fake }, { sealed_at: new Date() },
    ]) {
      await expect(withTenant(t, (tx) => tx`
        INSERT INTO audit_log ${tx({ tenant_id: t, id: randomUUID(), actor_type: "system", surface: "system", action: "test.forged", ...cols })}`))
        .rejects.toThrow(/inserted unsealed/);
    }
    await write(t, "test.honest");
    await sealAll(t);
    expect(await verifyTenant(t)).toMatchObject({ ok: true });
  });
});

describe("audit verify over HTTP", () => {
  it("concurrent verifies don't queue: while one runs, the others get 409 at once", async () => {
    const ws = await newWorkspace("Verify busy");
    const t = ws.tenantId;
    await sealAll(t);
    expect((await call("GET", "/v1/audit/verify", { key: ws.keys.admin })).status).toBe(200);
    // Hold the tenant's verify/anchor lock, as a long verify (or an anchor) would.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const didLock = new Promise<void>((r) => (locked = r));
    const holder = db().begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`audit-anchor:${t}`}))`;
      locked();
      await held;
    });
    await didLock;
    try {
      const started = Date.now();
      const results = await Promise.all(Array.from({ length: 8 }, () => call("GET", "/v1/audit/verify", { key: ws.keys.admin })));
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(409));
      expect(results[0]!.json).toMatchObject({ code: "retry", detail: expect.stringMatching(/already running/) });
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      release();
      await holder;
    }
    // Racing calls with nothing held: every call either verifies or is told to retry; none waits.
    const raced = await Promise.all(Array.from({ length: 6 }, () => call("GET", "/v1/audit/verify", { key: ws.keys.admin })));
    expect(raced.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(raced.some((r) => r.status === 200)).toBe(true);
    expect(raced.filter((r) => r.status === 200).every((r) => r.json.data.ok)).toBe(true);
    // The CLI path waits instead.
    expect((await verifyTenant(t)).ok).toBe(true);
  });
});

describe("audit chain tampering is detected", () => {
  it("a changed row", async () => {
    const t = await sealedTenant("Tamper change");
    await tamper(t, (tx) => tx`UPDATE audit_log SET details = '{"x": 1}' WHERE audit_log.chain_pos = 3`);
    expect(await verifyTenant(t)).toMatchObject({ ok: false, problem: expect.stringMatching(/position 3 .*does not match its hash/) });
  });

  it("a removed row", async () => {
    const t = await sealedTenant("Tamper remove");
    await tamper(t, (tx) => tx`DELETE FROM audit_log WHERE audit_log.chain_pos = 2`);
    expect(await verifyTenant(t)).toMatchObject({ ok: false, problem: expect.stringMatching(/position 2 is missing/) });
  });

  it("a removed row with the positions renumbered to hide the gap", async () => {
    const t = await sealedTenant("Tamper renumber");
    await tamper(t, async (tx) => {
      await tx`DELETE FROM audit_log WHERE audit_log.chain_pos = 2`;
      await tx`UPDATE audit_log SET chain_pos = -chain_pos WHERE audit_log.chain_pos > 2`;
      await tx`UPDATE audit_log SET chain_pos = -chain_pos - 1 WHERE audit_log.chain_pos < 0`;
    });
    expect(await verifyTenant(t)).toMatchObject({ ok: false, problem: expect.stringMatching(/chain broken at position 2/) });
  });

  it("reordered rows", async () => {
    const t = await sealedTenant("Tamper reorder");
    await tamper(t, async (tx) => {
      await tx`UPDATE audit_log SET chain_pos = -1 WHERE audit_log.chain_pos = 2`;
      await tx`UPDATE audit_log SET chain_pos = 2 WHERE audit_log.chain_pos = 3`;
      await tx`UPDATE audit_log SET chain_pos = 3 WHERE audit_log.chain_pos = -1`;
    });
    expect(await verifyTenant(t)).toMatchObject({ ok: false, problem: expect.stringMatching(/chain broken at position 2/) });
  });

  it("a dropped tail, which leaves the remaining links intact, is caught by the anchor", async () => {
    const t = await sealedTenant("Tamper tail");
    const head = (await positions(t)).at(-1)!;
    await tamper(t, (tx) => tx`DELETE FROM audit_log WHERE seq = ${head.seq}::bigint`);
    expect(await verifyTenant(t)).toMatchObject({ ok: false, problem: expect.stringMatching(/anchor at seq \d+ does not match the chain/) });
  });
});

describe("audit anchors", () => {
  const anchorFile = (t: string, seq: string) => join(process.env.BLOB_DIR!, "audit-anchors", t, `${seq.padStart(20, "0")}.json`);
  const anchors = (t: string) => withTenant(t, (tx) => tx<{ seq: string }[]>`SELECT seq::text FROM audit_anchors`);

  it("an anchor missing from write-once storage fails verification", async () => {
    const t = await sealedTenant("Anchor missing");
    const [a] = await anchors(t);
    await rm(anchorFile(t, a!.seq));
    expect(await verifyTenant(t)).toMatchObject({ ok: false, problem: expect.stringMatching(/missing from write-once storage/) });
  });

  it("an anchor that storage holds but the database lost fails verification", async () => {
    const t = await sealedTenant("Anchor dropped");
    await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${t}, true)`;
      await tx`DELETE FROM audit_anchors`;
    });
    expect(await verifyTenant(t)).toMatchObject({ ok: false, problem: expect.stringMatching(/storage holds an anchor .* the database does not/) });
  });

  it("an anchor that differs from storage fails verification", async () => {
    const t = await sealedTenant("Anchor differs");
    const [a] = await anchors(t);
    await rm(anchorFile(t, a!.seq));
    await writeFile(anchorFile(t, a!.seq), JSON.stringify({ seq: a!.seq, hash: "00".repeat(32) }));
    expect(await verifyTenant(t)).toMatchObject({ ok: false, problem: expect.stringMatching(/differs from write-once storage/) });
  });
});
