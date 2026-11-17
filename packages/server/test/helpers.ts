import { buildApp } from "../src/api/app.js";
import { createWorkspace } from "../src/core/workspace.js";
import { decodeId } from "../src/lib/ids.js";

export const app = buildApp();

export interface Workspace { keys: { admin: string; ops: string }; ownerId: string; tenantId: string; ownerEmail: string; id: string; name: string }

let n = 0;
export async function newWorkspace(name = "Test"): Promise<Workspace> {
  n++;
  const ws = await createWorkspace({ name: `${name} ${n}`, ownerEmail: `owner${n}-${Date.now()}@example.com`, ownerName: "Owner" });
  return { keys: ws.keys, ownerId: ws.owner.id, tenantId: decodeId(ws.workspace.id)!.uuid, ownerEmail: ws.owner.email, id: ws.workspace.id, name: ws.workspace.name };
}

export interface CallOpts { key: string; body?: unknown; headers?: Record<string, string> }

export async function call(method: string, path: string, opts: CallOpts) {
  const res = await app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${opts.key}`,
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  // JSON and problem+json are parsed; anything else (a CSV or NDJSON export) is returned as its text.
  const json = /[/+]json(;|$)/.test(res.headers.get("content-type") ?? "") || !res.headers.get("content-type");
  return { status: res.status, headers: res.headers, json: text ? (json ? JSON.parse(text) : text) : undefined };
}

/** Creates a record and returns its data, failing loudly if the API refuses. */
export async function create(key: string, object: string, values: Record<string, unknown>) {
  const r = await call("POST", `/v1/objects/${object}/records`, { key, body: values });
  if (r.status !== 201) throw new Error(`create ${object} failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data as Record<string, unknown> & { id: string; version: number };
}

export const uniqueEmail = (s: string) => `${s}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

/** Adds a member with `role` (via the owner's admin key) and gives them a key with `scopes`. */
export async function memberWithKey(ws: Workspace, role: string, scopes: string[]) {
  const m = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: uniqueEmail(role), name: `M ${role}`, role } });
  if (m.status !== 201) throw new Error(`add member failed: ${m.status} ${JSON.stringify(m.json)}`);
  const k = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: `${role} key`, scopes, owner: m.json.data.id } });
  if (k.status !== 201) throw new Error(`create key failed: ${k.status} ${JSON.stringify(k.json)}`);
  return { id: m.json.data.id as string, key: k.json.data.secret as string, keyId: k.json.data.id as string };
}

// --- Browsers (people sign-in, ADR 0009) -----------------------------------------------------------

export const ORIGIN = "https://crm.test";

/** A minimal browser: keeps cookies from Set-Cookie (honouring Max-Age=0) and sends them back, with a same-origin Origin on writes. */
export class Browser {
  readonly cookies = new Map<string, string>();
  csrf: string | null = null;
  constructor(readonly userAgent = "test-browser/1") {}

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  /** Sends a request. `form` posts application/x-www-form-urlencoded (as the pages do); `body` posts JSON. */
  async request(method: string, path: string, opts: { body?: unknown; form?: Record<string, string>; headers?: Record<string, string>; csrf?: boolean } = {}) {
    const headers: Record<string, string> = { "User-Agent": this.userAgent, ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {}) };
    if (method !== "GET") {
      headers.Origin = ORIGIN;
      headers["Sec-Fetch-Site"] = "same-origin";
    }
    if (opts.csrf !== false && this.csrf && method !== "GET") headers["X-CSRF-Token"] = this.csrf;
    let body: string | undefined;
    if (opts.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.form).toString();
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      if (v === "") delete headers[k];
      else headers[k] = v;
    }
    const res = await app.request(path, { method, headers, body, redirect: "manual" });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i);
      if (/Max-Age=0(;|$)/.test(sc)) this.cookies.delete(name);
      else this.cookies.set(name, pair!.slice(i + 1));
    }
    const text = await res.text();
    const isJson = /[/+]json(;|$)/.test(res.headers.get("content-type") ?? "");
    const json = text && isJson ? JSON.parse(text) : undefined;
    if (json?.csrf_token) this.csrf = json.csrf_token;
    return { status: res.status, headers: res.headers, json, text, setCookies: res.headers.getSetCookie() };
  }
}

/** Signs a browser in as a member through a server-printed link, and fetches its CSRF token. */
export async function signedIn(email: string, workspaceId?: string, browser = new Browser()): Promise<Browser> {
  const { createServerLink } = await import("../src/auth/signin.js");
  const link = await createServerLink(email, workspaceId, "test");
  const token = new URL(link.url).searchParams.get("token")!;
  const r = await browser.request("POST", "/auth/server-link", { body: { token } });
  if (r.status !== 200 || r.json.status !== "signed_in") throw new Error(`sign-in failed: ${r.status} ${JSON.stringify(r.json)}`);
  return browser;
}

/** Captures email instead of sending it. */
export class FakeMailer {
  readonly name = "fake";
  readonly enabled = true;
  readonly sent: { to: string; subject: string; text: string }[] = [];
  async send(email: { to: string; subject: string; text: string }) {
    this.sent.push(email);
  }
  lastTo(to: string) {
    return [...this.sent].reverse().find((e) => e.to.toLowerCase() === to.toLowerCase());
  }
  codeFor(to: string) {
    return /code is (\d{4}) (\d{4})/.exec(this.lastTo(to)?.text ?? "")?.slice(1).join("") ?? null;
  }
  linkFor(to: string) {
    return /(https:\/\/crm\.test\/auth\/email-link\?token=[A-Za-z0-9_-]+)/.exec(this.lastTo(to)?.text ?? "")?.[1] ?? null;
  }
}

// --- Response shapes ---------------------------------------------------------------------------

export type Schema = Record<string, unknown>;

/** A small JSON Schema checker for the keywords the document uses. Returns the paths that don't match. */
export function validate(doc: Schema, s: Schema, v: unknown, path = "$"): string[] {
  if (typeof s.$ref === "string") return validate(doc, (doc.components as { schemas: Record<string, Schema> }).schemas[s.$ref.split("/").pop()!]!, v, path);
  if (Array.isArray(s.anyOf)) return s.anyOf.some((x) => validate(doc, x as Schema, v, path).length === 0) ? [] : [`${path}: matches no anyOf`];
  if (Array.isArray(s.oneOf)) {
    const ok = s.oneOf.filter((x) => validate(doc, x as Schema, v, path).length === 0).length;
    return ok === 1 ? [] : [`${path}: matches ${ok} of oneOf`];
  }
  const errs: string[] = [];
  const types = s.type === undefined ? null : ([] as unknown[]).concat(s.type);
  const typeOf = (x: unknown) => (x === null ? "null" : Array.isArray(x) ? "array" : Number.isInteger(x) ? "integer" : typeof x);
  if (types && !types.some((t) => t === typeOf(v) || (t === "number" && typeof v === "number"))) return [`${path}: ${typeOf(v)} is not ${types.join("|")}`];
  if (s.const !== undefined && v !== s.const) errs.push(`${path}: not ${String(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.includes(v)) errs.push(`${path}: not in enum`);
  if (typeof v === "number" && typeof s.minimum === "number" && v < s.minimum) errs.push(`${path}: below ${s.minimum}`);
  if (typeof v === "number" && typeof s.maximum === "number" && v > s.maximum) errs.push(`${path}: above ${s.maximum}`);
  if (Array.isArray(v) && s.items) v.forEach((x, i) => errs.push(...validate(doc, s.items as Schema, x, `${path}[${i}]`)));
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const r of (s.required as string[] | undefined) ?? []) if (!(r in v)) errs.push(`${path}.${r}: missing`);
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const [k, x] of Object.entries(v)) {
      if (props[k]) errs.push(...validate(doc, props[k], x, `${path}.${k}`));
      else if (s.additionalProperties === false) errs.push(`${path}.${k}: not allowed`);
      else if (s.additionalProperties && typeof s.additionalProperties === "object") errs.push(...validate(doc, s.additionalProperties as Schema, x, `${path}.${k}`));
    }
  }
  return errs;
}
