import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Hono } from "hono";
import type { Env } from "../api/app.js";
import { webUiOn } from "../config.js";
import { logger } from "../lib/logger.js";

/**
 * Serves the built web UI (packages/web) from the API's own origin, so the browser session cookie and
 * the CSRF checks work without CORS. On when the built files are present, unless WEB_UI=false; an
 * API-only deployment without them behaves exactly as before.
 *
 * - Files of the build: `/assets/*` are content-hashed, so cached for a year and immutable; other files
 *   at the top of the build (an icon) are revalidated (ETag, Last-Modified, 304).
 * - The app's HTML shell answers only the app's own client routes (the top-level paths listed in the
 *   build's app-routes.json, which comes from packages/web/src/app-routes.json), only for GET and HEAD,
 *   and only to a request that accepts HTML. Everything else, including any path the API owns or may
 *   own later (/v1, /auth, /oauth, /mcp, /.well-known, …), falls through to the API's JSON 404. The
 *   decision is made on the percent-decoded, lower-cased first segment, so /V1/me, /v1%2fme and /v1;/me
 *   are not mistaken for app routes.
 * - The shell is never stored (no-store) and carries a Content-Security-Policy: scripts, styles, images,
 *   fonts and requests from this origin only, no inline script, and a per-response nonce for the few
 *   <style> elements UI libraries insert (scroll locking).
 * - Files and the shell are held in memory and re-read only when the file on disk changed (checked at
 *   most every two seconds), so a rebuild needs no restart and no request reads the disk synchronously.
 */

const NONCE_PLACEHOLDER = "__HLCRM_STYLE_NONCE__";
const MANIFEST = "app-routes.json";
/** How long a file's on-disk state is trusted before it is checked again. */
const RECHECK_MS = 2000;
/** Files above this are served from disk each time rather than held in memory. */
const MAX_CACHED_FILE = 8 * 1024 * 1024;

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".map": "application/json",
};

interface CachedFile { body: Buffer; etag: string; mtimeMs: number; size: number; checkedAt: number }

export interface WebUi {
  dir: string;
  /** First path segments (lower case) the app owns, from the build's app-routes.json; "" is the root. */
  routes: Set<string>;
  shell: CachedFile;
  files: Map<string, CachedFile>;
}

/** The package root of the server (one level above src/ or dist/). */
const serverRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where the built UI is: WEB_UI_DIR, else next to the server in the image (/app/web), else the monorepo's packages/web/dist. */
export function webUiCandidates(): string[] {
  const set = process.env.WEB_UI_DIR?.trim();
  if (set) return [resolve(set)];
  return [join(serverRoot(), "web"), resolve(serverRoot(), "..", "web", "dist")];
}

const etagOf = (body: Buffer) => `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;

/** The app's top-level route segments from a manifest's text; throws when it is not the expected shape. */
export function parseRouteManifest(text: string): Set<string> {
  const parsed = JSON.parse(text) as { routes?: unknown };
  if (!Array.isArray(parsed.routes) || !parsed.routes.every((r) => typeof r === "string" && /^\/[a-z0-9-]*$/.test(r))) {
    throw new Error(`${MANIFEST} must hold {"routes": ["/", "/top-level-path", …]}`);
  }
  return new Set((parsed.routes as string[]).map((r) => r.slice(1)));
}

/** The UI to serve, or null when it is turned off or not built. Read once at startup; says why when WEB_UI_DIR is set but unusable. */
export function loadWebUi(): WebUi | null {
  // Read from the environment directly (as config.ts defines them): the app is built before some callers
  // finish setting the environment, and config() caches what it reads first.
  if (!webUiOn(process.env.WEB_UI)) return null;
  const explicit = Boolean(process.env.WEB_UI_DIR?.trim());
  for (const dir of webUiCandidates()) {
    const index = join(dir, "index.html");
    if (!existsSync(index) || !statSync(index).isFile()) {
      if (explicit) logger.warn({ dir }, "WEB_UI_DIR is set but holds no index.html: the web UI is not served");
      continue;
    }
    let routes: Set<string>;
    try {
      routes = parseRouteManifest(readFileSync(join(dir, MANIFEST), "utf8"));
    } catch (e) {
      // An older or partial build: the shell is still served at / (the app routes from there), but a reload elsewhere is a 404.
      logger.warn({ dir, err: (e as Error).message }, `the web UI build has no usable ${MANIFEST}: only / gets the app`);
      routes = new Set([""]);
    }
    const body = readFileSync(index);
    const st = statSync(index);
    return { dir: realpathSync(dir), routes, shell: { body, etag: etagOf(body), mtimeMs: st.mtimeMs, size: st.size, checkedAt: Date.now() }, files: new Map() };
  }
  return null;
}

let current: WebUi | null | undefined;

/** The UI this process serves (read on first use), or null. */
export function webUi(): WebUi | null {
  if (current === undefined) current = loadWebUi();
  return current;
}

/** Forgets the loaded UI, so the next webUi() looks again. For tests. */
export function resetWebUi(): void {
  current = undefined;
}

/** One line for the startup log: whether the UI is served, and from where. */
export function describeWebUi(ui: WebUi | null): { web_ui: string } {
  if (ui) return { web_ui: `served from ${ui.dir}` };
  return { web_ui: webUiOn(process.env.WEB_UI) ? "not served (no built UI found; build packages/web or set WEB_UI_DIR)" : "not served (WEB_UI=false)" };
}

/** The policy for the app's HTML shell. `nonce` covers style elements only; scripts come from this origin alone. */
export function webUiCsp(nonce: string): string {
  return [
    "default-src 'self'", "script-src 'self'", `style-src 'self' 'nonce-${nonce}'`, "img-src 'self' data:", "font-src 'self'",
    "connect-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'",
  ].join("; ");
}

/** The request path percent-decoded, or null when it can't be (bad encoding, a NUL, a dot segment). */
function decodedPath(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").some((s) => s === "." || s === "..")) return null;
  return decoded;
}

/** True when the path is one of the app's client routes: its decoded, lower-cased first segment is in the manifest. */
export function isAppRoute(ui: Pick<WebUi, "routes">, urlPath: string): boolean {
  const decoded = decodedPath(urlPath);
  if (decoded === null || !decoded.startsWith("/")) return false;
  const first = decoded.slice(1).split("/")[0]!.toLowerCase();
  if (first === "") return decoded === "/" && ui.routes.has("");
  return ui.routes.has(first);
}

/** Whether the request takes HTML: what a browser asks for when it loads a page. */
function acceptsHtml(c: Context<Env>): boolean {
  const accept = (c.req.header("accept") ?? "").toLowerCase();
  return /(^|,)\s*(text\/html|application\/xhtml\+xml|\*\/\*)\s*(;|,|$)/.test(accept);
}

/** A file inside the build directory, or null: no dot files, no escaping the directory (also through symlinks). */
async function fileIn(ui: WebUi, urlPath: string): Promise<string | null> {
  const decoded = decodedPath(urlPath);
  if (decoded === null || decoded.split("/").some((s) => s.startsWith("."))) return null;
  const full = resolve(ui.dir, `.${decoded}`);
  if (!full.startsWith(ui.dir + sep)) return null;
  try {
    if (!(await stat(full)).isFile()) return null;
    const real = await realpath(full);
    return real.startsWith(ui.dir + sep) ? real : null;
  } catch {
    return null;
  }
}

/** A file's bytes and validators from memory, re-read when it changed on disk. Hashed assets never change, so they are never checked again. */
async function cachedFile(ui: WebUi, file: string, immutable: boolean): Promise<CachedFile | null> {
  const now = Date.now();
  const hit = ui.files.get(file);
  if (hit && (immutable || now - hit.checkedAt < RECHECK_MS)) return hit;
  try {
    const st = await stat(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      hit.checkedAt = now;
      return hit;
    }
    const body = await readFile(file);
    const entry = { body, etag: etagOf(body), mtimeMs: st.mtimeMs, size: st.size, checkedAt: now };
    if (body.length <= MAX_CACHED_FILE) ui.files.set(file, entry);
    return entry;
  } catch {
    return null;
  }
}

/** The shell from memory, re-read when a new build replaced it (so a rebuild doesn't need a restart). */
async function currentShell(ui: WebUi): Promise<Buffer> {
  const now = Date.now();
  if (now - ui.shell.checkedAt < RECHECK_MS) return ui.shell.body;
  ui.shell.checkedAt = now;
  try {
    const index = join(ui.dir, "index.html");
    const st = await stat(index);
    if (st.mtimeMs !== ui.shell.mtimeMs || st.size !== ui.shell.size) {
      const body = await readFile(index);
      ui.shell = { body, etag: etagOf(body), mtimeMs: st.mtimeMs, size: st.size, checkedAt: now };
    }
  } catch {
    // Keep serving the copy in memory.
  }
  return ui.shell.body;
}

async function sendShell(c: Context<Env>, ui: WebUi) {
  const nonce = randomBytes(18).toString("base64");
  const body = Buffer.from((await currentShell(ui)).toString("utf8").replaceAll(NONCE_PLACEHOLDER, nonce), "utf8");
  c.header("Content-Security-Policy", webUiCsp(nonce));
  // Each response has its own nonce, so a stored copy would be wrong: never store it.
  c.header("Cache-Control", "no-store");
  c.header("Content-Type", "text/html; charset=utf-8");
  c.header("Content-Length", String(body.length));
  if (c.req.method === "HEAD") return c.body(null);
  return c.body(new Uint8Array(body));
}

/** True when the request's validators show it already holds this version. If-None-Match wins over If-Modified-Since. */
function notModified(c: Context<Env>, f: CachedFile): boolean {
  const inm = c.req.header("if-none-match");
  if (inm !== undefined) return inm.split(",").map((t) => t.trim().replace(/^W\//, "")).some((t) => t === f.etag || t === "*");
  const ims = c.req.header("if-modified-since");
  if (!ims) return false;
  const since = Date.parse(ims);
  return Number.isFinite(since) && Math.floor(f.mtimeMs / 1000) * 1000 <= since;
}

/** Mounts the UI after every API route. Returns whether it is served. */
export function mountWebUi(app: Hono<Env>, ui: WebUi | null, notFound: (c: Context<Env>) => Response | Promise<Response>): boolean {
  if (!ui) return false;
  app.on(["GET", "HEAD"], "*", async (c) => {
    const path = c.req.path;
    if (path === "/index.html") return acceptsHtml(c) ? sendShell(c, ui) : notFound(c);
    // A file of the build, when one is there (never the manifest's own routes: those are the app's).
    const file = path.endsWith("/") || path === "/" ? null : await fileIn(ui, path);
    if (file) {
      const hashed = path.startsWith("/assets/");
      const f = await cachedFile(ui, file, hashed);
      if (!f) return notFound(c);
      c.header("Content-Type", TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
      c.header("Cache-Control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
      c.header("X-Content-Type-Options", "nosniff");
      c.header("ETag", f.etag);
      c.header("Last-Modified", new Date(f.mtimeMs).toUTCString());
      if (notModified(c, f)) return c.body(null, 304);
      c.header("Content-Length", String(f.body.length));
      if (c.req.method === "HEAD") return c.body(null);
      return c.body(new Uint8Array(f.body));
    }
    // A missing build file is a 404, never the shell: a stale cached page asking for an old chunk must fail clearly.
    if (path.toLowerCase().startsWith("/assets/")) return notFound(c);
    if (isAppRoute(ui, path) && acceptsHtml(c)) return sendShell(c, ui);
    return notFound(c);
  });
  return true;
}
