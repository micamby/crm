import { randomBytes } from "node:crypto";
import { sha256 } from "../lib/crypto.js";
import { ALL_SCOPES, type Scope } from "../core/context.js";

/**
 * The resources (MCP endpoints) OAuth tokens are issued for, the scopes each accepts, and the token
 * formats (ADR 0010). No database or configuration here: the MCP process imports this too.
 *
 * Scopes are the API key scopes, with one hierarchy: `ops:write` implies `ops:read`. A token's
 * effective access is, as for a key, the member's current role ∩ what its scopes unlock.
 */

export type ResourceName = "ops" | "admin";
export const RESOURCES: ResourceName[] = ["ops", "admin"];

/** Scopes a token for each resource may carry. The ops server never takes `admin`. */
export const RESOURCE_SCOPES: Record<ResourceName, Scope[]> = {
  ops: ["ops:read", "ops:write", "restricted:read"],
  admin: ["admin", "ops:read", "ops:write", "restricted:read"],
};

/** What a client gets when it asks for no scope, and what a 401 challenge suggests: enough for the server's tools. */
export const DEFAULT_SCOPES: Record<ResourceName, Scope[]> = { ops: ["ops:read", "ops:write"], admin: ["admin", "ops:read"] };

/** A token for the resource is useless without one of these (the MCP endpoints check the same on every request). */
export const REQUIRED_SCOPES: Record<ResourceName, Scope[]> = { ops: ["ops:read", "ops:write"], admin: ["admin"] };

export const surfaceOf = (r: ResourceName): "ops-mcp" | "admin-mcp" => (r === "ops" ? "ops-mcp" : "admin-mcp");

export const isScope = (s: string): s is Scope => (ALL_SCOPES as string[]).includes(s);

/** Adds the scopes a scope implies: `ops:write` brings `ops:read`, so a role that can no longer write still reads. */
export function expandScopes(scopes: Iterable<string>): Scope[] {
  const out = new Set([...scopes].filter(isScope));
  if (out.has("ops:write")) out.add("ops:read");
  return ALL_SCOPES.filter((s) => out.has(s));
}

/** True when the effective scopes are enough for the resource at all. */
export const satisfies = (r: ResourceName, scopes: Iterable<string>) => {
  const have = new Set(scopes);
  return REQUIRED_SCOPES[r].some((s) => have.has(s));
};

/** Plain-language descriptions for the consent page. */
export const SCOPE_TEXT: Record<Scope, string> = {
  "ops:read": "Read records (contacts, accounts, deals, leads, tasks and custom objects), the schema, pipelines and recent changes",
  "ops:write": "Create, change and archive records, log activities and move deals (and read them)",
  "restricted:read": "See the values of fields marked restricted",
  admin: "Change the CRM's setup: objects, fields, pipelines, modules, automations, webhooks and alerts; read the audit log and the member list",
};

/**
 * Tokens: 256 random bits, base64url, behind a prefix so a secret scanner can recognise them and a
 * request can tell them from API keys (hlcrm_live_… / hlcrm_test_…) and from each other.
 */
export const ACCESS_PREFIX = "hlcrm_oat_";
export const REFRESH_PREFIX = "hlcrm_ort_";
export const CODE_PREFIX = "hlcrm_oac_";
const shape = (prefix: string) => new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`);
export const ACCESS_TOKEN_PATTERN = shape(ACCESS_PREFIX);
export const REFRESH_TOKEN_PATTERN = shape(REFRESH_PREFIX);
export const CODE_PATTERN = shape(CODE_PREFIX);
/** The shape of an hl-crm-db API key (core/keys.ts): such a bearer value takes the API key path everywhere. */
export const looksLikeApiKey = (s: string) => /^hlcrm_(live|test)_[0-9A-Za-z]{52}$/.test(s);
export const isAccessToken = (s: unknown): s is string => typeof s === "string" && ACCESS_TOKEN_PATTERN.test(s);

export const newSecret = (prefix: string): string => `${prefix}${randomBytes(32).toString("base64url")}`;
export const secretHash = (secret: string): Buffer => sha256(secret);

/** The header the MCP process sends its shared secret in when it calls the API for an OAuth token. */
export const SERVICE_HEADER = "x-hlcrm-mcp-service";
