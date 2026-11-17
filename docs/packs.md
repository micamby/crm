# Schema packs

A schema pack is a folder (or a single file) you can share. It sets up a workspace for one use case, such as recruiting, real estate or a support desk. It holds a manifest and up to three parts:

- **schema**: objects, fields and pipelines, in the [schema document format](cli.md#the-file-format), without IDs;
- **roles**: custom roles with their permissions and object and field rules;
- **views**: shared saved views, by object and name.

Two example packs live in [`packs/`](../packs): [`recruiting`](../packs/recruiting) and [`support-desk`](../packs/support-desk). They use the address, json, rating, percent and duration field types. Unlike the server (AGPL), the examples are [MIT](../packs/LICENSE), so you can copy them into your own packs.

As built: `core/packs.ts` (server), `api/routes-packs.ts` (routes), `packages/cli/src/packfile.ts` and `commands/pack.ts` (CLI), migration 017 (`installed_packs`).

## The format

A folder:

```
recruiting/
  pack.yaml       the manifest (or pack.json)
  schema.yaml     the schema part (or .yml / .json)
  roles.yaml      roles: [...]
  views.yaml      views: [...]
```

Only those file names are read. A single file holds the manifest keys and the parts inline (`schema:`, `roles:`, `views:`).

The manifest:

```yaml
name: recruiting            # 2 to 63 lowercase letters, digits and hyphens; a pack's identity in a workspace
version: 1.0.0              # MAJOR.MINOR.PATCH
description: Candidates, job openings and applications for a small hiring team.
min_server_version: 0.1.0   # refused by an older server
modules: [core]             # modules that must be on in the workspace
parts: [schema, roles, views]  # exactly the parts the pack holds
license: MIT                # optional, informational
```

Every key is checked, and an unknown key is an error. `parts` must list exactly the parts present: a part that is listed but missing, or present but not listed, is refused. `automations` is refused in this version.

Schema part: the schema document's `objects` and `pipelines` (no `format`, `schema_version`, `modules` or IDs). A standard object (`contact`, `account`, …) may appear only with `name` and `fields`, which adds fields to it. A pipeline can't be the default.

```yaml
roles:
  - key: interviewer                 # role keys follow the API's rules; system roles (owner, admin, member, read_only) are refused
    name: Interviewer
    permissions: [records:read, records:write]
    objects: { candidate: { write: false } }
    fields: { candidate: { expected_salary: none } }

views:
  - name: In interview
    object: application
    where: { field: stage, op: eq, value: interview }
    sort: [{ field: score, dir: desc }]
    columns: [candidate, job, stage, score]
    group_by: []                     # optional
```

Limits per pack: 30 objects, 100 fields per object and 600 in all, 5 pipelines, 20 roles, 50 views. Descriptions can be at most 1,000 characters of plain text. In the CLI, each file can be at most 512 KB, and the API takes a request body of at most 1 MB.

## Commands

| Command | What it does |
|---|---|
| `crm pack init <dir>` | Writes a small example pack to a new folder. |
| `crm pack validate <dir>` | Checks the files and the manifest without a server. |
| `crm pack export <dir> --name <n>` | Writes a pack from this workspace: custom objects (`--object`, repeatable; a standard object adds only its custom fields), `--pipeline`, `--role` (custom roles), and `--views` (shared views on the exported objects). |
| `crm pack plan <dir>` | Shows what installing or upgrading would change, and what was changed in this workspace and will be kept. Writes nothing. Exit code 0 means nothing to change, 5 means changes to apply, 1 means the workspace can't take something. Takes `--prune`, `--overwrite-changes` and `--allow-downgrade` as install does. |
| `crm pack install <dir>` | Shows the plan, asks, then applies exactly that plan in one transaction. Use `--yes` under `--no-input`. `--prune` also removes what an earlier version created and this one drops. `--overwrite-changes` replaces what was changed in this workspace, after showing each item before and after. `--allow-downgrade` installs a version older than the one last installed. |
| `crm pack list` | Lists installed packs, and uninstalled ones, with what each owns. |
| `crm pack uninstall <name>` | Shows what would be archived, asks, then archives it. `--confirm-records` is needed when the pack's objects or fields hold data. |

API: `POST /v1/packs/plan`, `POST /v1/packs/apply`, `GET /v1/packs`, `POST /v1/packs/{name}/uninstall` (a dry run by default). The CLI reads the files and sends them; the server checks and applies everything. A plan returns a `plan_token`, and apply needs it (see [Plan, then apply exactly that](#plan-then-apply-exactly-that)).

**Export** never includes records, members, keys, webhooks or automations. It leaves out IDs, relation defaults (which are record IDs), and role permissions a pack can't carry. A view's filter is kept only when every condition tests for empty values, or compares whole values that are configuration: `eq`, `neq`, `in` or `not_in` with option keys of a select or status field (`contains` with one option key on a multi-select), `true` or `false` on a boolean, or ratings from 1 to the field's max (ordering operators too, since a rating can't hold text). Any other condition, such as `starts_with` on a select or a value that is not one of its options, may hold record values such as an email or a name, so the whole filter is left out with a note (dropping one condition from an `or` or a `not` would change what the view shows). Read an exported pack before you share it: labels, descriptions, select values and defaults are written as they are.

## Install, upgrade, re-apply and uninstall

- **Install** applies the schema through schema apply's own functions, then the roles, then the views, in one database transaction. If anything is refused, nothing is installed. Plan runs the same work in a savepoint and rolls it back, so it shows exactly what apply would do.
- **Ownership.** `installed_packs` records the pack's name, version, who installed it and when, and the IDs it created, keyed by pack-local names (`candidate`, `candidate.rating`, `recruiter`, `candidate/Top rated candidates`). An upgrade changes only what the pack owns, matched by those IDs. Fields you add yourself to a pack's object stay yours.
- **No adoption.** An object, field, role or pipeline of the same name that the pack didn't create is listed under "cannot be applied", and the install is refused. A standard object gains fields but is never changed.
- **What people change after install stays theirs.** For everything a pack owns, `installed_packs` also records what the pack last wrote: a fingerprint of the properties it sets on an object (label, plural label, description, display field, hidden), a field (name, type, label, description, required, hidden, sensitivity, default, rules and options), a pipeline (name and stages), and a role (name, description, permissions and its object and field rules, with the role's `access_version`), and a view's `version`. On a re-apply or upgrade, anything whose workspace copy differs from what the pack last wrote is **kept**: the plan lists it under `kept` ("changed in this workspace since the pack installed it; kept") and apply leaves it alone. An object kept this way keeps its own properties, while its fields still follow the pack. So an admin who tightens a pack's role (hides a field, denies archiving) keeps that rule through every re-apply and upgrade.
- **`overwrite_changes: true`** replaces those items with the pack's version instead. The plan then lists each one under `overwritten` with the workspace's copy (`before`) and the pack's (`after`); a role update also lists the permissions added and removed and each object and field rule before and after. Anything that **widens access** is flagged with `widens_access` (a permission added, a deny or field limit removed or loosened, an allow added, a field's sensitivity lowered), and apply refuses it (409) without `confirm_access_changes: true`. This holds for a role change a newer version makes too, overwrite or not. The CLI prints all of it before it asks.
- **The same version again**, with nothing changed in the pack, writes nothing: no change, no audit entry, no row update. A **newer version** is planned and applied as above. An **older version** than the one last installed is refused (409), also after an uninstall, unless the request says `allow_downgrade: true`. The same version with different content is applied as an upgrade, since the version is the author's label.
- **What a newer version drops** is kept and listed in the plan's notes. With `prune`, dropped fields are archived (values kept; this counts as a data change, so it needs `confirm_data_changes`), dropped roles are archived, and dropped views are deleted. Prune never removes something changed in this workspace since the pack wrote it. Dropped objects are archived only by uninstall. A field renamed between versions is treated as a new field, and the old one follows the rule above.
- **A pack installed before these fingerprints were kept** has none, so everything it owns counts as possibly changed and is kept ("installed before changes were tracked"). Apply it once with `overwrite_changes` (after reading the plan) to start tracking.
- **Uninstall** archives the objects the pack created (their records are kept and hidden with them), archives the fields it added to other objects (values kept), and archives its roles. It deletes its views, except views someone changed since install, which are kept. Pipelines are kept, because deals may use them. Nothing else is deleted. It is a dry run by default. The real run needs the dry run's `confirm_token`, plus `confirm_records: true` when records or values would be hidden. The token works once, only for the credential that ran the dry run, and only while the pack, the schema and the preview are as the dry run saw them (409 `plan_changed` otherwise). It is refused while a field the pack didn't create relates to one of its objects (archive that field first), or while an active member holds one of its roles. It is also refused (409 `pack_in_use`) while an automation or alert rule that isn't archived uses what it would archive: one of the pack's objects (a trigger, a step, a filter), a field the pack added to another object (an address part or json path counts as its field), or one of its roles in an automation's `run_roles`. The dry run lists them under `in_use` (kind, ID, name, and what each uses; a personal alert rule without its name) so you can change or archive them first; `crm pack uninstall` prints the list and exits 4. Webhooks subscribed to the pack's objects' events are named in the notes: they simply stop receiving those events.
- **Reinstalling** an uninstalled pack restores the objects and fields that the pack being applied still lists, with their data, and creates its roles and views again. An object or field it no longer lists stays archived (a note says so), so an older or smaller pack of the same name restores no more than its own manifest describes. A restore is checked against the limits of 100 custom objects and 300 fields per object. Records or values coming back are a data change: the plan marks them, and apply needs `confirm_data_changes`. An archived pack object keeps its name and ID prefix, so creating a new object with that name is refused (409) until the pack is reinstalled.

### Plan, then apply exactly that

`POST /v1/packs/plan` returns a `plan_token`. It is signed by the server and bound to the credential that planned (the API key, the signed-in member across their sessions, or a connected app's connection, which can't apply it), the pack body and options, the schema version, the pack's row in `installed_packs`, and the plan itself (changes, kept and overwritten items). `POST /v1/packs/apply` needs it (400 without it, or from another credential) and runs the plan again inside the request: if anything differs, for example a field was added or a record created since, it refuses with 409 `plan_changed` and writes nothing. Plan again and review the new plan. A token expires after 15 minutes and works once. It proves that what is applied is what was planned, not that a person read the plan. `crm pack install` plans, shows the plan, asks, and passes the token, plus `confirm_data_changes` and `confirm_access_changes` for what it showed.

## Permissions

Every pack route first needs one of `schema:manage`, `roles:manage` or `views:manage`, checked before the request body is read, any lock is taken or row read, a heavy-request slot is used or any rate-limit cost is charged. A caller without any of them gets the same 403 whether or not a pack of that name exists. `GET /v1/packs` needs the same. Then each part needs its permission, and a pack is applied whole: `schema:manage` for a schema part, `roles:manage` for roles and `views:manage` for views. Upgrade and uninstall also need the permissions for parts the pack already owns. A pack must hold at least one object, pipeline, role or view, so there is always a part to check. A pack's roles go through role creation's own checks: the installer must hold every permission and all the record access the role grants. Its views go through view creation's checks, so a filter, sort, grouping or column on a field the installer can't read is refused (403).

**Which credentials.** Packs are installed by people: with an API key (the CLI) or in a browser session (writes need the CSRF token, like every write). A connected app (OAuth for MCP) may plan and list packs, which write nothing, but apply and uninstall are refused (403), and so is a key whose client says it is an MCP server (`X-Hlcrm-Surface`): a pack creates roles and changes the schema in one step, and there is no MCP tool for packs. See the credential table in [`permissions.md`](permissions.md#sessions-and-keys).

## Safety: installing packs from others

A pack is untrusted input. The server treats it that way, and so should you.

- **Read it first.** `crm pack plan` lists every object, field, role and view the pack would create. Look at its roles in particular: what they allow, and which fields they hide.
- **What a pack can't contain:** automations, webhooks, API keys, members, service accounts, records, or anything that sends data out of the workspace. Its roles can hold only `records:read`, `records:write`, `records:archive`, `restricted:read` and `views:manage`, never member, key, role, webhook, automation, alert, schema or audit permissions. It can't touch system roles, take over an existing object, field, role or pipeline, change a standard object, or set the default pipeline.
- **It can't grant more than you hold:** role creation's escalation checks apply as for any role.
- **Names and descriptions are data.** They are stored and shown as text. Agents see object and field descriptions through `describe_object`, as tool results and never as instructions. There is no MCP tool for packs, and the MCP server instructions never include pack text. Text with control characters, C1 controls, line or paragraph separators or bidi controls is refused in a manifest, and the CLI strips control characters when it prints.
- **Reading a folder:** the CLI reads only `pack.*`, `schema.*`, `roles.*` and `views.*` from the folder you name. It never follows a name written inside the pack, and never reads through a symbolic link: each file is opened without following links and checked through the open handle, so it can't be swapped between the check and the read. It refuses files over 512 KB, text that isn't UTF-8, and YAML with more than 100 aliases.
- **Your changes win.** Re-applying or upgrading a pack never undoes a role you tightened or a view, field or object you edited; it lists them as kept. Overwriting them needs `--overwrite-changes`, shows each before and after, and flags anything that gives more access.
- **Limits** bound the work one pack can ask for (see above). Plan and apply are heavy requests, and their rate-limit cost grows with the pack's size.
- A pack can still create fields marked `restricted` or `confidential` and hide fields from roles, so its roles may see less than you expect. The plan shows all of this.

## Not in this version

- **Automations in packs.** The extension point is noted in `core/packs.ts`. Adding them would need a stable automation identity (for owned-ID tracking), a check that their actions send nothing outside the workspace, the escalation rule that `automations:manage` implies, and archiving on uninstall. Packs still carry no automations, and uninstall refuses while an automation uses what it would archive (above).
- **A pack directory** to browse and download packs. A directory would need rules for who may publish, pack signing and review before listing, since a pack is untrusted input.
- **Signing packs** or checking an author's identity.
