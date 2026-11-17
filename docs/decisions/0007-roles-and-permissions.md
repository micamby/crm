# 0007: Roles and permissions, with key scopes kept as a narrowing layer

Status: accepted (2026-11-13)

## Context

Until now a member had one of four hard-coded roles, and a key's scopes (`admin`, `ops:write`, `ops:read`, `restricted:read`) were checked in the routes. Two problems:

- Workspaces could not express "can manage webhooks but not change the schema", or "read-only, without restricted values". The only way to get a narrower human or agent was a narrower key.
- Authorization was spread over two ideas (role ceiling, scope check) with checks written route by route. A route that forgot its check was open to any admin key.

## Decision

**A fixed catalog of permissions, and roles built from it.** The code defines twelve permissions (`records:read`, `records:write`, `records:archive`, `restricted:read`, `schema:manage`, `members:manage`, `roles:manage`, `keys:manage`, `webhooks:manage`, `automations:manage`, `alerts:manage`, `audit:read`). Workspaces cannot invent permissions, because a permission only means something if a route checks it. A `roles` table holds, per workspace, four system roles and any custom roles. Each user and service account has exactly one role. One role per member keeps "what can this person do" answerable with one lookup, which is what an access review needs. Combining roles can come later if it is wanted.

**Routes authorize by permission.** Every route declares the permission it needs, or derives it from its scope and tag. At startup the API refuses to serve a route that resolves to none, so a new admin route cannot be left open by accident.

**Scopes stay, and only narrow.** A key's effective permissions are its member's role permissions intersected with what the key's scopes unlock. Scopes were kept because they are how a key is made smaller than its owner: an admin can hold an `ops:read`-only key for a dashboard, and the MCP ops and admin servers rely on the `ops:*` and `admin` split. Dropping them would have forced a role per use case. Making them a cap, never a grant, means they cannot undermine roles. The role is read on every request, so a role change or a disabled member takes effect at once without touching keys.

**System roles are locked.** `owner`, `admin`, `member` and `read_only` cannot be edited or archived. Their meaning stays the same in every workspace, in the docs and in support, and nobody can lock everyone out by editing the role they all hold. The definitions are seeded by a database function, so a migration and the code agree (a test checks it). To get a variation, create a custom role with `copy_from`.

**Escalation rules, enforced in the service layer:**

- Nobody grants a permission they do not hold: creating or editing a role, assigning a role, and minting a key for someone else all check this.
- Nobody changes a role they hold, or their own role, or disables themselves.
- Nobody acts on a member who holds permissions they lack.
- Only an owner assigns the owner role, changes or disables an owner, or manages an owner's keys. Service accounts cannot be owners.
- The last active owner cannot be demoted or disabled. The check locks the owner rows, so two owners demoting each other at once leave one.
- A key's scopes must be a subset of the calling key's, and usable by the owner's role.

**Disabling a member revokes their keys,** in the same transaction, so deprovisioning cannot leave a working credential. Re-enabling does not restore keys.

**Access review is a read endpoint** (`GET /v1/access-review`): every member with role, permissions and keys. It supports an operator's periodic review. It does not schedule one.

**Every change is audited,** with permissions added and removed on role changes and the number of keys revoked on a disable.

## Consequences

- Permissions apply across all objects. There are no per-object or per-field permissions. Restricted fields are the one field-level control. This is a known limit, not a decision against adding them. (Since added: ADR 0008.)
- The MCP servers and the SDK have no role-management tools or methods, on purpose: role changes are the most sensitive admin action and are a poor fit for an agent that can be prompt-injected. They are reachable through the REST API only.
- Migration 006 moves existing users and service accounts to the matching system role and drops the old `role` column. It is one-way.
- `hlcrm_test_` keys are a label, not a sandbox. Scopes and roles apply to them the same way.
- The `X-Hlcrm-Surface` header is advisory, so the surface rules (admin routes refused on the ops surface) narrow a key but are not part of the authorization model.
- Authentication reads the member's role on every request, which costs one extra join per request in exchange for immediate effect.
