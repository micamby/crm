import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import { actions, limits, type ObjectAccess } from "../access.js";
import type { Context } from "../context.js";
import { CliError, EXIT, usage } from "../errors.js";
import { clean } from "../output.js";
import type { Act } from "../program.js";
import { DEFAULT_SCHEMA_FILE, formatDoc, readDoc, renderPlan, type Plan, type SchemaDoc } from "../schemafile.js";

/** plan's exit code: what CI should do next. Drift that can't all be listed counts as a conflict, as apply treats it (412). */
function planExit(plan: Plan): number {
  if (plan.unsupported.length) return EXIT.failure;
  if (plan.drift_truncated || plan.drift.some((d) => d.conflicts)) return EXIT.conflict;
  return plan.changes.length ? EXIT.changes : EXIT.ok;
}

async function fetchPlan(ctx: Context, doc: SchemaDoc, prune: boolean): Promise<Plan> {
  return ctx.client().post<Plan>("/v1/schema/plan", { document: doc, ...(prune ? { prune: true } : {}) });
}

export function registerSchema(program: Command, act: Act): void {
  const schema = program.command("schema").description("Schema-as-code: pull the workspace schema to a file, plan changes to it, apply them");

  schema.command("pull")
    .description(`Write the workspace schema to a file (YAML; JSON if the name ends in .json; - for stdout), with the version it was pulled at`)
    .option("-o, --output <file>", "where to write it", DEFAULT_SCHEMA_FILE)
    .action(act(async (ctx, opts: { output: string }) => {
      const { access, ...doc } = await ctx.client().get<SchemaDoc & { access?: ObjectAccess[] }>("/v1/schema/export");
      // `access` describes this key, not the workspace: it stays out of the file, which is the same whoever pulls it.
      if (access) {
        const l = limits(access);
        ctx.out.info(`Note: this key's record access is limited (${l.slice(0, 5).join("; ")}${l.length > 5 ? "; …" : ""}). The file still lists every object and field: names are not data. See crm doctor.`);
      }
      const text = formatDoc(doc, opts.output === "-" ? "-.yaml" : opts.output);
      if (opts.output === "-") return void ctx.out.raw(text);
      writeFileSync(opts.output, text);
      if (ctx.g.json) return ctx.out.data({ file: opts.output, schema_version: doc.schema_version });
      ctx.out.line(`Wrote ${opts.output} (schema version ${String(doc.schema_version)}).`);
    }));

  schema.command("plan")
    .description("Show what applying a schema file would change, and what changed in the workspace since it was pulled. Writes nothing")
    .option("-f, --file <file>", "the schema file", DEFAULT_SCHEMA_FILE)
    .option("--prune", "also plan archiving custom fields that are in the workspace but not in the file")
    .option("--verbose", "list name matches and notes")
    .addHelpText("after", "\nExit codes: 0 no changes, 5 changes to apply, 4 the changes would overwrite something changed since the pull, 1 the file asks for something apply cannot do.")
    .action(act(async (ctx, opts: { file: string; prune?: boolean; verbose?: boolean }) => {
      const plan = await fetchPlan(ctx, readDoc(opts.file), Boolean(opts.prune));
      ctx.exitCode = planExit(plan);
      if (ctx.g.json) return ctx.out.data(plan);
      renderPlan(ctx.out, plan, { verbose: opts.verbose });
    }));

  schema.command("apply")
    .description("Apply a schema file: shows the plan, asks for confirmation, then makes every change in one transaction")
    .option("-f, --file <file>", "the schema file", DEFAULT_SCHEMA_FILE)
    .option("--accept-drift", "apply even if it overwrites schema changes made since the file was pulled")
    .option("--prune", "archive custom fields that are in the workspace but not in the file (needs --yes or a confirmation)")
    .option("--verbose", "list name matches and notes")
    .addHelpText("after", "\nWith --no-input (or without a terminal) --yes is required. Archiving fields or converting stored values always needs\n"
      + "--yes or an answer at the prompt.")
    .action(act(async (ctx, opts: { file: string; acceptDrift?: boolean; prune?: boolean; verbose?: boolean }) => {
      const doc = readDoc(opts.file);
      if (doc.schema_version === undefined && !opts.acceptDrift) {
        throw usage(`${opts.file} has no schema_version, so changes made in the workspace can't be detected. Pull the schema first, or pass --accept-drift`);
      }
      const plan = await fetchPlan(ctx, doc, Boolean(opts.prune));
      if (!ctx.g.json) renderPlan(ctx.out, plan, { verbose: opts.verbose });
      if (plan.unsupported.length) throw new CliError("schema_unsupported", "The file asks for changes schema apply cannot make (listed above)", EXIT.failure, { details: plan.unsupported });
      if (plan.changes.length === 0) {
        if (ctx.g.json) ctx.out.data({ applied: false, ...plan });
        return;
      }
      const conflicts = plan.drift.filter((d) => d.conflicts);
      if ((conflicts.length || plan.drift_truncated) && !opts.acceptDrift) {
        throw new CliError("schema_drift", `Applying would overwrite ${plan.drift_truncated ? "changes" : `${conflicts.length} change(s)`} made since version ${String(doc.schema_version)}. `
          + "Pull again and redo your edits, or pass --accept-drift to overwrite them", EXIT.conflict, { details: conflicts });
      }
      const affecting = plan.changes.filter((c) => c.data_affecting).length;
      await ctx.confirm(
        `Apply ${plan.changes.length} change(s)${affecting ? `, ${affecting} of them archiving fields or converting stored values` : ""}? [y/N] `,
        `${plan.changes.length} change(s) to apply${affecting ? `, ${affecting} changing stored data` : ""}`,
      );
      const result = await ctx.client().post<Plan & { applied: boolean }>("/v1/schema/apply", {
        document: doc, ...(opts.prune ? { prune: true } : {}), ...(opts.acceptDrift ? { accept_drift: true } : {}), ...(affecting ? { confirm_data_changes: true } : {}),
      }, doc.schema_version !== undefined ? { ifMatch: doc.schema_version } : {});
      if (ctx.g.json) return ctx.out.data(result);
      ctx.out.line(`Applied ${result.changes.length} change(s); the workspace schema is now version ${result.schema_version}.`);
      ctx.out.line(`Run crm schema pull -o ${opts.file} to record the new version and the IDs of anything created.`);
    }));

  schema.command("describe [object]")
    .description("Without an object: every object with its record count and what this key can do with it. With one: its fields and this key's access to each")
    .option("--hidden", "include hidden fields")
    .action(act(async (ctx, object: string | undefined, opts: { hidden?: boolean }) => {
      const client = ctx.client();
      if (!object) {
        const s = (await client.get<{ data: { schema_version: number; modules: string[]; objects: Record<string, unknown>[] } }>("/v1/schema")).data;
        if (ctx.g.json) return ctx.out.data(s);
        ctx.out.line(`Schema version ${s.schema_version}; modules: ${s.modules.join(", ")}`);
        ctx.out.table(s.objects.map((o) => ({ ...o, kind: o.standard ? "standard" : "custom", access: o.access ? actions(o.access as ObjectAccess) : "" })),
          ["name", "label", "kind", "id_prefix", "records", "access"]);
        return;
      }
      const o = (await client.get<{ data: { name: string; label: string; fields: Record<string, unknown>[]; access?: ObjectAccess } & Record<string, unknown> }>(
        `/v1/objects/${encodeURIComponent(object)}`, { include_hidden: opts.hidden ? "true" : undefined })).data;
      if (ctx.g.json) return ctx.out.data(o);
      ctx.out.line(`${clean(o.label)} (${o.name}), IDs ${String(o.id_prefix)}_…${o.description ? ` — ${clean(String(o.description))}` : ""}`);
      if (o.access) ctx.out.line(`This key: ${actions(o.access)}. Fields with access none are left out of its records and exports.`);
      ctx.out.table(o.fields.map((f) => ({
        ...f, flags: [f.required && "required", f.unique && "unique", f.hidden && "hidden", f.read_only && "read-only", f.sensitivity, f.standard ? "standard" : "custom"].filter(Boolean),
        detail: f.relation ? `→ ${String((f.relation as { to: string }).to)}` : f.values ? (f.values as { key: string }[]).map((v) => v.key).join(", ") : "",
      })), ["name", "label", "type", "access", "flags", "detail"]);
    }));
}
