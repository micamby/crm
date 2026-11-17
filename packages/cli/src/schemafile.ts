import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import { CliError, EXIT } from "./errors.js";
import { clean, type Out } from "./output.js";

/** A schema document as the API exports it (see docs/cli.md for the format). Kept loose: the server validates it. */
export interface SchemaDoc {
  format?: string;
  schema_version?: number;
  [k: string]: unknown;
}

export const DEFAULT_SCHEMA_FILE = "crm.schema.yaml";

const HEADER = [
  " hl-crm-db schema document, written by `crm schema pull`.",
  " Edit it, then run `crm schema plan` to see the changes and `crm schema apply` to make them.",
  " IDs (obj_, fld_, pipe_, stg_) keep track of things across renames: leave them in place. New entries need none.",
  " schema_version is the workspace version this file was pulled at; apply uses it to spot changes made since.",
  " Properties you leave out are left as they are. Nothing is archived unless you apply with --prune.",
].join("\n");

const isJson = (path: string) => path.toLowerCase().endsWith(".json");

/** Serializes a document as YAML (with an explanatory header) or, for a .json path, as JSON. */
export function formatDoc(doc: SchemaDoc, path: string): string {
  if (isJson(path)) return `${JSON.stringify(doc, null, 2)}\n`;
  const d = new YAML.Document(doc);
  d.commentBefore = HEADER;
  return d.toString({ lineWidth: 0 });
}

/** Reads a YAML or JSON document. YAML aliases are capped by the parser, so a hostile file cannot expand without bound. */
export function parseDoc(text: string, path: string): SchemaDoc {
  let doc: unknown;
  try {
    doc = isJson(path) ? JSON.parse(text) : YAML.parse(text, { uniqueKeys: true, maxAliasCount: 100 });
  } catch (e) {
    throw new CliError("schema_file_invalid", `${path} is not valid ${isJson(path) ? "JSON" : "YAML"}: ${(e as Error).message.split("\n")[0]}`, EXIT.usage);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new CliError("schema_file_invalid", `${path} must hold a mapping (objects:, pipelines:, …)`, EXIT.usage);
  return doc as SchemaDoc;
}

export function readDoc(path: string): SchemaDoc {
  if (!existsSync(path)) throw new CliError("file_not_found", `${path} not found (crm schema pull writes it)`, EXIT.usage);
  return parseDoc(readFileSync(path, "utf8"), path);
}

// --- Plans, rendered for people ----------------------------------------------------------------

interface Change { change: string; object: string; field?: string; before?: Record<string, unknown> | unknown; after?: Record<string, unknown> | unknown;
  warning?: string; data_affecting?: boolean }
export interface Plan {
  schema_version: number;
  document_version: number | null;
  changes: Change[];
  unsupported: { path: string; message: string }[];
  notes: string[];
  matched_by_name: { path: string; reason: string }[];
  drift: { version: number; changed_at: string; change: string; object: string | null; field: string | null; actor: string; surface: string; conflicts: boolean }[];
  drift_truncated?: boolean;
}

const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? "none");
const rec = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** One line per change: + adds, ~ changes, - archives. */
export function describeChange(c: Change): { sign: "+" | "~" | "-"; text: string } {
  const before = rec(c.before);
  const after = rec(c.after);
  const target = c.field ? `${c.object}.${c.field}` : c.object;
  const diff = () => Object.keys(after).filter((k) => !["pipeline", "stage"].includes(k))
    .map((k) => `${k} ${show(before[k])} → ${show(after[k])}`).join(", ");
  switch (c.change) {
    case "object_created": return { sign: "+", text: `create object ${c.object} (IDs ${String(after.id_prefix)}_…)` };
    case "field_added": return { sign: "+", text: `add field ${target} (${String(after.type)})` };
    case "field_updated":
      if (after.api_name !== undefined) {
        const rest = Object.keys(after).filter((k) => k !== "api_name");
        return { sign: "~", text: `rename field ${target} → ${String(after.api_name)}${rest.length ? `; ${rest.map((k) => `${k} ${show(before[k])} → ${show(after[k])}`).join(", ")}` : ""}` };
      }
      return { sign: "~", text: `update field ${target}: ${diff()}` };
    case "field_retyped": return { sign: "~", text: `retype field ${target}: ${String(before.type)} → ${String(after.type)}` };
    case "field_archived": return { sign: "-", text: `archive field ${target}` };
    case "object_updated": return { sign: "~", text: `update object ${c.object}: ${diff()}` };
    case "modules_updated": return { sign: "~", text: `modules ${show(c.before)} → ${show(c.after)}` };
    case "pipeline_created": return { sign: "+", text: `create pipeline ${show(after.name)} with stages ${show(after.stages)}` };
    case "pipeline_updated": return { sign: "~", text: `update pipeline ${String(after.pipeline)}: ${diff()}` };
    case "stage_added": return { sign: "+", text: `add stage ${show(after.name)} (${String(after.category)}) to ${String(after.pipeline)}` };
    case "stage_updated": return { sign: "~", text: `update stage ${String(after.stage)}: ${diff()}` };
    case "stages_reordered": return { sign: "~", text: `reorder the stages of ${String(after.pipeline)}` };
    // Schema packs (crm pack): restoring, archiving, and their roles and views.
    case "object_restored": return { sign: "+", text: `restore object ${c.object} (archived when the pack was uninstalled)` };
    case "field_restored": return { sign: "+", text: `restore field ${target}` };
    case "object_archived": return { sign: "-", text: `archive object ${c.object} (records kept)` };
    case "role_created": return { sign: "+", text: `create role ${show(after.key)} with ${show(after.permissions)}` };
    case "role_updated": return { sign: "~", text: `update role ${show(after.key)}` };
    case "role_archived": return { sign: "-", text: `archive role ${show(before.key)}` };
    case "view_created": return { sign: "+", text: `create shared view ${show(after.name)} on ${c.object}` };
    case "view_updated": return { sign: "~", text: `update shared view ${show(after.name)} on ${c.object}` };
    case "view_deleted": return { sign: "-", text: `delete shared view ${show(before.name)} on ${c.object}` };
    default: return { sign: "~", text: `${c.change} ${target}` };
  }
}

export function renderPlan(out: Out, plan: Plan, opts: { verbose?: boolean } = {}): void {
  const from = plan.document_version === null ? "a document without schema_version" : `document version ${plan.document_version}`;
  out.line(out.paint("bold", `Plan: workspace schema version ${plan.schema_version}, ${from}`));
  if (plan.changes.length === 0) out.line("  No changes.");
  for (const c of plan.changes) {
    const { sign, text } = describeChange(c);
    const tone = sign === "+" ? "add" : sign === "-" ? "remove" : "change";
    out.line(`  ${out.paint(tone, sign)} ${clean(text)}${c.data_affecting ? out.paint("warn", "  [changes stored data]") : ""}`);
    if (c.warning) out.line(out.paint("dim", `      ${clean(c.warning)}`));
  }
  if (plan.unsupported.length) {
    out.line();
    out.line(out.paint("remove", "Cannot be applied:"));
    for (const u of plan.unsupported) out.line(`  ! ${clean(u.path)}: ${clean(u.message)}`);
  }
  if (plan.drift.length) {
    out.line();
    out.line(out.paint("bold", `Changed in the workspace since ${from}:`));
    for (const d of plan.drift) {
      const what = [d.object, d.field].filter(Boolean).join(".");
      out.line(`  v${d.version} ${d.changed_at.slice(0, 19).replace("T", " ")} ${d.change} ${clean(what)} by ${d.actor} (${d.surface})`
        + (d.conflicts ? out.paint("remove", "  ← this plan would overwrite it") : ""));
    }
    if (plan.drift_truncated) out.line(out.paint("warn", "  (more changes than shown; pull the schema again)"));
  } else if (plan.drift_truncated) {
    out.line();
    out.line(out.paint("warn", `What changed in the workspace since ${from} can't be told (see --verbose notes); apply treats it as drift. Pull the schema again`));
  }
  if (plan.matched_by_name.length) {
    out.line();
    out.line(`${plan.matched_by_name.length} entr${plan.matched_by_name.length === 1 ? "y was" : "ies were"} matched by name (no ID, or an ID from another workspace)${opts.verbose ? ":" : "; --verbose lists them"}`);
    if (opts.verbose) for (const m of plan.matched_by_name) out.line(`  ${clean(m.path)}: ${m.reason}`);
  }
  if (plan.notes.length && opts.verbose) {
    out.line();
    for (const n of plan.notes) out.line(out.paint("dim", `  ${clean(n)}`));
  } else if (plan.notes.length) {
    out.line(out.paint("dim", `${plan.notes.length} note(s) about things left as they are; --verbose lists them`));
  }
  const affecting = plan.changes.filter((c) => c.data_affecting).length;
  out.line();
  out.line(`${plan.changes.length} change(s)${affecting ? `, ${affecting} changing stored data` : ""}.`);
}
