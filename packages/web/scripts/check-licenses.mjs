#!/usr/bin/env node
/**
 * Licence check for the web UI's production dependencies (everything that ends up in the built app).
 * Fails (exit 1) on any licence that isn't on the permissive list below: copyleft, "source available",
 * commercial and unknown licences all fail. Run from anywhere: `pnpm licenses` at the repository root,
 * or `node packages/web/scripts/check-licenses.mjs`. Needs pnpm on the PATH.
 *
 * SPDX expressions are understood: "A OR B" passes when either side is allowed, "A AND B" only when both are.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED = new Set([
  "MIT", "MIT-0", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "Unlicense", "CC0-1.0", "BlueOak-1.0.0", "Zlib", "Python-2.0",
]);

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const root = join(pkgDir, "..", "..");

/** True when an SPDX expression is satisfied by allowed licences. */
export function allowed(expr) {
  if (typeof expr !== "string" || !expr.trim()) return false;
  const e = expr.trim().replace(/^\((.*)\)$/, "$1");
  if (/\sOR\s/i.test(e)) return e.split(/\s+OR\s+/i).some(allowed);
  if (/\sAND\s/i.test(e)) return e.split(/\s+AND\s+/i).every(allowed);
  return ALLOWED.has(e.replace(/[()]/g, "").trim());
}

const raw = execFileSync("pnpm", ["--filter", "@hl-crm-db/web", "licenses", "list", "--prod", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const byLicence = JSON.parse(raw);
const problems = [];
let count = 0;
for (const [licence, pkgs] of Object.entries(byLicence)) {
  for (const p of pkgs) {
    count++;
    if (!allowed(licence)) problems.push(`${p.name}@${(p.versions ?? []).join(",")}: ${licence}`);
  }
}

// Workspace packages the app imports (pnpm lists only registry packages).
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  if (!String(spec).startsWith("workspace:")) continue;
  const dir = join(root, "packages", name.split("/").pop());
  const licence = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).license;
  count++;
  if (!allowed(licence)) problems.push(`${name} (workspace): ${licence ?? "no licence"}`);
}

if (problems.length) {
  process.stderr.write(`Licence check failed: ${problems.length} production dependenc${problems.length === 1 ? "y has" : "ies have"} a licence that isn't allowed:\n  ${problems.join("\n  ")}\n`);
  process.exit(1);
}
process.stdout.write(`Licence check passed: ${count} production packages, all under ${[...new Set(Object.keys(byLicence))].sort().join(", ")}.\n`);
