import { beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/db/tx.js";
import { WORK_BUDGET_MS } from "../src/lib/errors.js";
import { decodeId } from "../src/lib/ids.js";
import { app, call, create, memberWithKey, newWorkspace, uniqueEmail, type Workspace } from "./helpers.js";
import { csvRow, guardFormula, parseCsv, unguardFormula } from "../src/lib/csv.js";

describe("CSV (RFC 4180)", () => {
  it("parses quoted fields with commas, doubled quotes and line breaks, CRLF or LF, and a BOM", () => {
    const text = '﻿name,notes\r\n"Doe, Jane","She said ""hi""\r\nthen left"\r\nBob,plain\nCarl,\n';
    expect(parseCsv(text)).toEqual({ rows: [["name", "notes"], ["Doe, Jane", 'She said "hi"\r\nthen left'], ["Bob", "plain"], ["Carl", ""]], lines: [1, 2, 4, 5] });
  });

  it("skips blank lines, keeps empty fields and handles a missing final newline", () => {
    expect(parseCsv("a,b\n\n,\nx,y").rows).toEqual([["a", "b"], ["", ""], ["x", "y"]]);
    expect(parseCsv('""').rows).toEqual([[""]]);
    expect(parseCsv("").rows).toEqual([]);
  });

  it("rejects malformed quoting with the line number", () => {
    expect(() => parseCsv('a\n"open')).toThrow(/line 2: a quoted field is not closed/);
    expect(() => parseCsv('a\nab"c')).toThrow(/line 2: a quote inside an unquoted field/);
    expect(() => parseCsv('"a"b')).toThrow(/line 1: unexpected text after a closing quote/);
    expect(() => parseCsv("a\nb\nc", { maxRows: 2 })).toThrow(/more than 2 rows/);
  });

  it("serializes so that parsing gives back the same fields", () => {
    const fields = ["plain", "with,comma", 'with "quote"', "line\nbreak", "cr\r\nlf", "", " spaced "];
    expect(csvRow(fields)).toBe('plain,"with,comma","with ""quote""","line\nbreak","cr\r\nlf",, spaced \r\n');
    expect(parseCsv(csvRow(fields)).rows).toEqual([fields]);
  });

  it("guards cells a spreadsheet would run as formulas, and import removes the guard", () => {
    for (const s of ["=SUM(A1)", "+1", "-1", "@cmd", "\tx", "\rx"]) {
      expect(guardFormula(s)).toBe(`'${s}`);
      expect(unguardFormula(guardFormula(s))).toBe(s);
    }
    expect(guardFormula("plain")).toBe("plain");
    expect(unguardFormula("'quoted")).toBe("'quoted");
  });

  it("round-trips every value exactly: unguard(guard(s)) is s, through a CSV file too", () => {
    const starts = ["", "'", "''", "'''", "=", "+", "-", "@", "\t", "\r", "\n", "﻿", " ", "a", "0", '"', ","];
    const rests = ["", "1", "+44 20 7946 0958", "SUM(A1)", "'", "=x", " ", "\t", "\r\n", "﻿", "ünï"];
    const values = [...starts.flatMap((a) => starts.flatMap((b) => rests.map((c) => a + b + c))), "'+44", "''=x", "'-1", "'@", "-12.5", "+1 (555) 010"];
    for (const v of values) expect(unguardFormula(guardFormula(v))).toBe(v);
    // A value the guard leaves alone is never changed by import either.
    for (const v of values) if (guardFormula(v) === v) expect(unguardFormula(v)).toBe(v);
    const text = csvRow(["value"]) + values.map((v) => csvRow([guardFormula(v)])).join("");
    expect(parseCsv(text).rows.slice(1).map((r) => unguardFormula(r[0]!))).toEqual(values.filter((v) => v !== ""));
    // A stored value that really starts with an apostrophe before + gets a second one, and keeps its first.
    expect(guardFormula("'+44")).toBe("''+44");
  });
});

let ws: Workspace;
beforeAll(async () => {
  ws = await newWorkspace("Transfer");
  const f = await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "ssn", type: "text", sensitivity: "restricted" } });
  expect(f.status).toBe(201);
  const g = await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "vip", type: "boolean" } });
  expect(g.status).toBe(201);
});

async function exportText(key: string, path: string) {
  const res = await app.request(path, { headers: { Authorization: `Bearer ${key}` } });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe("export", () => {
  let tag: string;
  beforeAll(async () => {
    tag = `exp${Date.now()}`;
    const acct = await create(ws.keys.ops, "account", { name: `${tag} Corp`, domain: `${tag}.example` });
    await create(ws.keys.admin, "contact", { first_name: "=HYPERLINK(\"x\")", last_name: tag, email: uniqueEmail("a"), account: acct.id, ssn: "123-45-6789" });
    await create(ws.keys.admin, "contact", { first_name: "Plain, \"quoted\"", last_name: tag, email: uniqueEmail("b"), vip: true });
    await create(ws.keys.admin, "contact", { first_name: "Third", last_name: tag, email: uniqueEmail("c") });
  });

  it("returns CSV with the documented columns, filtered like the list route, formulas guarded", async () => {
    const r = await exportText(ws.keys.admin, `/v1/objects/contact/export?filter[last_name]=${tag}&sort=first_name&dir=asc`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(r.headers.get("x-row-count")).toBe("3");
    expect(r.headers.get("x-next-cursor")).toBeNull();
    const { rows } = parseCsv(r.text);
    const header = rows[0]!;
    expect(header[0]).toBe("id");
    expect(header).toEqual(expect.arrayContaining(["first_name", "email", "account", "ssn", "vip", "created_at", "updated_at", "version"]));
    const col = (name: string) => header.indexOf(name);
    expect(rows.slice(1).map((x) => x[col("first_name")])).toEqual(["'=HYPERLINK(\"x\")", "Plain, \"quoted\"", "Third"]);
    // Restricted values follow the caller's permissions exactly as in list: this key can read them, the ops key cannot.
    expect(rows[1]![col("ssn")]).toBe("123-45-6789");
    const asOps = parseCsv((await exportText(ws.keys.ops, `/v1/objects/contact/export?filter[last_name]=${tag}&sort=first_name&dir=asc`)).text).rows;
    expect(asOps[1]![col("ssn")]).toBe("[restricted]");
    const listed = await call("GET", `/v1/objects/contact/records?filter[last_name]=${tag}&sort=first_name&dir=asc`, { key: ws.keys.ops });
    expect(listed.json.data[0].ssn).toBe("[restricted]");
    expect(rows[2]![col("vip")]).toBe("true");
    expect(rows[1]![col("account")]).toMatch(/^acct_/);
  });

  it("continues with X-Next-Cursor when a response reaches its row limit", async () => {
    const first = await exportText(ws.keys.ops, `/v1/objects/contact/export?filter[last_name]=${tag}&limit=2`);
    expect(parseCsv(first.text).rows).toHaveLength(3);
    const cursor = first.headers.get("x-next-cursor");
    expect(cursor).toBeTruthy();
    const second = await exportText(ws.keys.ops, `/v1/objects/contact/export?filter[last_name]=${tag}&limit=2&cursor=${cursor}`);
    expect(parseCsv(second.text).rows).toHaveLength(2);
    expect(second.headers.get("x-next-cursor")).toBeNull();
  });

  it("returns NDJSON, one record per line, and records the export in the audit log", async () => {
    const r = await exportText(ws.keys.ops, `/v1/objects/contact/export?format=ndjson&filter[last_name]=${tag}`);
    const lines = r.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ object: "contact", last_name: tag });
    const log = await call("GET", "/v1/audit-log?action=contact.exported", { key: ws.keys.admin });
    expect(log.json.data[0].details).toMatchObject({ format: "ndjson", rows: 3, filtered: true });
  });

  it("needs records:read and refuses unknown formats", async () => {
    expect((await exportText(ws.keys.ops, "/v1/objects/contact/export?format=xml")).status).toBe(422);
    expect((await exportText("hlcrm_live_nope", "/v1/objects/contact/export")).status).toBe(401);
  });
});

const importCsv = (key: string, object: string, body: Record<string, unknown>) => call("POST", `/v1/objects/${object}/import`, { key, body });

describe("import", () => {
  let domain: string;
  beforeAll(async () => {
    domain = `imp${Date.now()}.example`;
    await create(ws.keys.ops, "account", { name: "Importer Inc", domain });
  });

  it("is a dry run by default, reporting each row and writing nothing", async () => {
    const email = uniqueEmail("dry");
    const csv = `Email,First,Company domain,VIP\n${email},Dee,${domain},yes\nnot-an-email,Bad,,\n`;
    const r = await importCsv(ws.keys.ops, "contact", { csv, mapping: { Email: "email", First: "first_name", "Company domain": "account.domain", VIP: "vip" }, key: "email" });
    expect(r.status).toBe(200);
    expect(r.json.dry_run).toBe(true);
    expect(r.json.counts).toEqual({ create: 1, update: 0, skip: 0, error: 1 });
    expect(r.json.rows[0]).toMatchObject({ row: 1, line: 2, action: "create" });
    expect(r.json.rows[1]).toMatchObject({ row: 2, line: 3, action: "error", reason: expect.stringContaining("email") });
    const found = await call("GET", `/v1/objects/contact/records?filter[email]=${encodeURIComponent(email)}`, { key: ws.keys.ops });
    expect(found.json.data).toEqual([]);
  });

  it("creates, updates by key and skips unchanged rows; relation columns resolve by a unique field", async () => {
    const existing = await create(ws.keys.ops, "contact", { first_name: "Old", email: uniqueEmail("upd") });
    const fresh = uniqueEmail("new");
    const csv = [
      "email,first_name,account,vip",
      `${fresh},New,${domain},true`,
      `${existing.email as string},Updated,,`,
      `${existing.email as string},Updated,,`, // same file, same key: the second row finds nothing to change
    ].join("\r\n");
    const r = await importCsv(ws.keys.ops, "contact", { csv, mapping: { account: "account.domain" }, key: "email", dry_run: false });
    expect(r.status).toBe(200);
    expect(r.json.counts).toEqual({ create: 1, update: 1, skip: 1, error: 0 });
    const created = await call("GET", `/v1/objects/contact/records?filter[email]=${encodeURIComponent(fresh)}`, { key: ws.keys.ops });
    expect(created.json.data[0]).toMatchObject({ first_name: "New", vip: true, account: expect.stringMatching(/^acct_/) });
    const updated = await call("GET", `/v1/objects/contact/records/${existing.id}`, { key: ws.keys.ops });
    expect(updated.json.data).toMatchObject({ first_name: "Updated", version: 2 });
    const log = await call("GET", "/v1/audit-log?action=contact.imported", { key: ws.keys.admin });
    expect(log.json.data[0].details).toMatchObject({ created: 1, updated: 1, skipped: 1, key: "email" });
  });

  it("looks up an owner by member email", async () => {
    const members = await call("GET", "/v1/members", { key: ws.keys.admin });
    const owner = members.json.data.users[0];
    const email = uniqueEmail("owned");
    const r = await importCsv(ws.keys.ops, "contact", { csv: `email,Owner\n${email},${owner.email.toUpperCase()}\n`, mapping: { Owner: "owner.email" }, dry_run: false });
    expect(r.json.counts.create).toBe(1);
    const found = await call("GET", `/v1/objects/contact/records?filter[email]=${encodeURIComponent(email)}`, { key: ws.keys.ops });
    expect(found.json.data[0].owner).toBe(owner.id);
  });

  it("is all or nothing: one bad row and no row is written", async () => {
    const good = uniqueEmail("good");
    const csv = `email,first_name,account\n${good},Good,\n${uniqueEmail("bad")},Bad,nowhere-${Date.now()}.example\n`;
    const r = await importCsv(ws.keys.ops, "contact", { csv, mapping: { account: "account.domain" }, key: "email", dry_run: false });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe("import_failed");
    expect(r.json.errors).toEqual([expect.objectContaining({ row: 2, action: "error", reason: expect.stringContaining("no account has domain") })]);
    const found = await call("GET", `/v1/objects/contact/records?filter[email]=${encodeURIComponent(good)}`, { key: ws.keys.ops });
    expect(found.json.data).toEqual([]);
  });

  it("round trip: an exported file imports back with nothing to change", async () => {
    const tag = `rt${Date.now()}`;
    await create(ws.keys.ops, "contact", { first_name: "-dash", last_name: tag, email: uniqueEmail("rt"), vip: false });
    const exported = await exportText(ws.keys.ops, `/v1/objects/contact/export?filter[last_name]=${tag}`);
    const r = await importCsv(ws.keys.ops, "contact", { csv: exported.text, dry_run: false });
    expect(r.status).toBe(200);
    expect(r.json.key).toBe("id");
    expect(r.json.counts).toEqual({ create: 0, update: 0, skip: 1, error: 0 });
    expect(r.json.ignored_columns).toEqual(expect.arrayContaining([{ column: "created_at", reason: "set by the system" }]));
  });

  it("rejects a row whose field count differs from the header's", async () => {
    const r = await importCsv(ws.keys.ops, "contact", { csv: `first_name,last_name\nA,B\nC,D,E\n` });
    expect(r.json.rows[1]).toMatchObject({ row: 2, line: 3, action: "error", reason: "has 3 field(s); the header has 2" });
  });

  it("validates the mapping and the key, and needs records:write", async () => {
    expect((await importCsv(ws.keys.ops, "contact", { csv: "a\n1\n", mapping: { a: "nope" } })).status).toBe(422);
    expect((await importCsv(ws.keys.ops, "contact", { csv: "email\nx@y.z\n", mapping: { b: "email" } })).status).toBe(422);
    expect((await importCsv(ws.keys.ops, "contact", { csv: "first_name\nx\n", key: "first_name" })).status).toBe(422);
    expect((await importCsv(ws.keys.ops, "contact", { csv: "first_name\nx\n", mapping: { first_name: "account.name" } })).status).toBe(422);
    const reader = await memberWithKey(ws, "read_only", ["ops:read"]);
    expect((await importCsv(reader.key, "contact", { csv: "first_name\nx\n" })).status).toBe(403);
    const many = `first_name\n${Array.from({ length: 501 }, (_, i) => `n${i}`).join("\n")}\n`;
    const tooMany = await importCsv(ws.keys.ops, "contact", { csv: many });
    expect(tooMany.status).toBe(422);
    expect(tooMany.json.detail).toMatch(/at most 500 rows/);
  });
});

describe("import limits and lookups", () => {
  it("looks a relation up by the exact value of a case-sensitive unique field", async () => {
    expect((await call("POST", "/v1/objects/account/fields", { key: ws.keys.admin, body: { api_name: "code", type: "text", unique: true } })).status).toBe(201);
    const tag = `c${Date.now()}`;
    const lower = await create(ws.keys.ops, "account", { name: "Lower", code: `${tag}abc` });
    const upper = await create(ws.keys.ops, "account", { name: "Upper", code: `${tag}ABC` });
    const [a, b] = [uniqueEmail("lc"), uniqueEmail("uc")];
    const r = await importCsv(ws.keys.ops, "contact", { csv: `email,account\n${a},${tag}abc\n${b},${tag}ABC\n`, mapping: { account: "account.code" }, dry_run: false });
    expect(r.status).toBe(200);
    const linked = async (email: string) => (await call("GET", `/v1/objects/contact/records?filter[email]=${encodeURIComponent(email)}`, { key: ws.keys.ops })).json.data[0].account;
    expect(await linked(a)).toBe(lower.id);
    expect(await linked(b)).toBe(upper.id);
    // Domains ignore case, as accounts store them: both spellings find the same account.
    const domain = `Case${Date.now()}.example`;
    const acct = await create(ws.keys.ops, "account", { name: "Cased", domain });
    const [c, d] = [uniqueEmail("d1"), uniqueEmail("d2")];
    expect((await importCsv(ws.keys.ops, "contact", { csv: `email,account\n${c},${domain}\n${d},${domain.toLowerCase()}\n`,
      mapping: { account: "account.domain" }, dry_run: false })).status).toBe(200);
    expect(await linked(c)).toBe(acct.id);
    expect(await linked(d)).toBe(acct.id);
  });

  it("refuses NUL characters with a 422, never a 500", async () => {
    const nul = await importCsv(ws.keys.ops, "contact", { csv: "first_name\nA\u0000B\n" });
    expect(nul.status).toBe(422);
    expect(nul.json.detail).toMatch(/NUL/);
    expect((await call("POST", "/v1/objects/contact/records", { key: ws.keys.ops, body: { first_name: "A\u0000" } })).status).toBe(422);
  });

  it("gives an import a time budget, checked between rows", async () => {
    WORK_BUDGET_MS.import = 0;
    try {
      const r = await importCsv(ws.keys.ops, "contact", { csv: "first_name\nSlow\n", dry_run: false });
      expect(r.status).toBe(503);
      expect(r.json.code).toBe("work_budget_exceeded");
    } finally {
      WORK_BUDGET_MS.import = 20_000;
    }
  });

  it("takes no unique-value locks in a dry run, so a dry run never waits on (or blocks) real writes", async () => {
    const doc = (await call("GET", "/v1/schema/export", { key: ws.keys.admin })).json;
    const code = doc.objects.find((o: { name: string }) => o.name === "account").fields.find((f: { name: string }) => f.name === "code");
    const fieldId = decodeId(code.id)!.uuid;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const holding = new Promise<void>((r) => (locked = r));
    // A real write in flight holds the field's lock until it commits.
    const writer = withTenant(ws.tenantId, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`unique:${fieldId}`}))`;
      locked();
      await gate;
    });
    await holding;
    try {
      const started = Date.now();
      const r = await importCsv(ws.keys.ops, "account", { csv: `name,code\nPreview,p${Date.now()}\n` });
      expect(r.status).toBe(200);
      expect(r.json.counts.create).toBe(1);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      release();
      await writer;
    }
  });

  it("counts an import against the key's rate limit by its rows", async () => {
    const m = await memberWithKey(ws, "member", ["ops:write"]);
    // 500 lines, six requests' worth. Blank lines make no rows, so this is cheap to run.
    const csv = `first_name\n${"\n".repeat(498)}x\n`;
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await importCsv(m.key, "contact", { csv })).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses).toContain(429);
  });
});
