import { z } from "zod";
import type { Tx } from "../db/pool.js";
import type { FieldType } from "../core/catalog.js";
import { ADDRESS_PART_NAMES, ratingMax, TYPE_INFO } from "../core/fieldtypes.js";
import { isModuleOn, loadSchema, type ObjectMeta } from "../core/schema.js";
import { cookieNames } from "../auth/cookies.js";
import { oauthSettings } from "../config.js";
import { ALL_SCOPES } from "../core/context.js";
import { SCOPE_TEXT } from "../oauth/scopes.js";
import { requiredPermission, routes } from "./registry.js";
import { BASE_SCHEMAS, ref, responsesFor, type JsonSchema } from "./responses.js";

/** Each type's value schema comes from the field type registry (core/fieldtypes.ts). */
const FIELD_SCHEMA = (t: FieldType): Record<string, unknown> => TYPE_INFO[t].schema;

/** What a write takes where it differs from what a read returns: address parts are optional (display is ignored), percent and duration take text too. */
const INPUT_SCHEMA: Partial<Record<FieldType, Record<string, unknown>>> = {
  address: { type: "object", additionalProperties: false, description: "Any of the parts; an empty address clears the field",
    properties: { ...Object.fromEntries(ADDRESS_PART_NAMES.map((p) => [p, { type: "string" }])), display: { type: "string", readOnly: true } } },
  percent: { anyOf: [{ type: "number" }, { type: "string", pattern: "^\\s*[+-]?\\d+(\\.\\d+)?\\s*%?\\s*$" }], description: "Percentage points: 12.5 or \"12.5%\"" },
  duration: { anyOf: [{ type: "integer", minimum: 0 }, { type: "string" }], description: "Seconds, or an ISO 8601 duration such as PT1H30M (no years or months)" },
};

/** A field's schema with null allowed: a type list gains "null"; a schema without a type (json: any value) already allows it. */
const orNull = (s: Record<string, unknown>): Record<string, unknown> =>
  (s.type === undefined ? s : { ...s, type: [...new Set([...([] as unknown[]).concat(s.type), "null"])] });

/**
 * One object's records as responses carry them. No field is required: a field the caller can't read is
 * absent. Restricted values come back as "[restricted]" without restricted:read, so they have no type.
 */
function recordSchema(o: ObjectMeta): JsonSchema {
  const base = BASE_SCHEMAS.Record as { properties: Record<string, JsonSchema> };
  const properties: Record<string, JsonSchema> = { ...base.properties, object: { type: "string", const: o.api_name } };
  for (const f of o.fields) {
    const many = f.type === "relation" && f.options.cardinality === "many_to_many";
    const s = many ? { type: "array", items: { type: "string" } }
      : f.type === "rating" ? { ...FIELD_SCHEMA(f.type), maximum: ratingMax(f) } : FIELD_SCHEMA(f.type);
    properties[f.api_name] = f.sensitivity === "restricted" ? { description: `${f.type}; "[restricted]" without restricted:read` }
      : { ...orNull(s), ...(f.description ? { description: f.description } : {}) };
  }
  return { type: "object", description: `A ${o.label} record`, properties, required: ["id", "object"], additionalProperties: true, "x-id-prefix": o.id_prefix };
}

/**
 * How MCP clients authenticate when OAuth for MCP is on (ADR 0010, docs/mcp/oauth.md). Listed so a reader
 * of this document knows the third credential kind exists, but no operation names it: tokens are issued
 * for the MCP servers (their audience), and /v1 accepts one only from the MCP process together with
 * MCP_SERVICE_SECRET, never from the app it was issued to or anyone else. The /oauth endpoints and the
 * discovery documents are left out of `paths`, like /auth.
 */
const MCP_OAUTH_SCHEME = {
  type: "oauth2",
  description: "OAuth 2.1 for the remote MCP servers only (docs/mcp/oauth.md): an MCP client gets an access token for the ops or admin MCP endpoint "
    + "(authorization code with PKCE, the resource parameter naming the endpoint) and sends it to that endpoint. The REST API under /v1 does not accept these "
    + "tokens from clients: a token sent here directly is refused with 401. Use an API key (bearer) or a browser session for /v1.",
  flows: {
    authorizationCode: {
      authorizationUrl: "/oauth/authorize", tokenUrl: "/oauth/token", refreshUrl: "/oauth/token",
      scopes: Object.fromEntries(ALL_SCOPES.map((sc) => [sc, SCOPE_TEXT[sc]])),
    },
  },
  "x-audience": "the MCP endpoints, not /v1",
};

/**
 * Builds the OpenAPI document from the route registry. With a tenant transaction it also
 * includes a schema for each of that workspace's objects, custom objects included.
 */
export async function buildOpenApi(tx: Tx | null): Promise<Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const path = r.path.replace(/:(\w+)/g, "{$1}");
    const params = [...r.path.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    const op: Record<string, unknown> = {
      summary: r.summary,
      tags: [r.tag],
      // A key (bearer) or a browser session (the session cookie, with X-CSRF-Token on writes); some routes take only a session.
      security: r.credential === "session" ? [{ session: [] }] : [{ bearer: [] }, { session: [] }],
      "x-required-scope": r.scope,
      "x-required-permission": requiredPermission(r),
      parameters: [
        ...params,
        ...(r.method !== "GET" ? [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } }] : []),
      ],
      responses: responsesFor(r.response),
    };
    if (r.body) {
      try {
        op.requestBody = { required: true, content: { "application/json": { schema: z.toJSONSchema(r.body as z.ZodType, { unrepresentable: "any" }) } } };
      } catch {
        op.requestBody = { required: true, content: { "application/json": { schema: { type: "object" } } } };
      }
    }
    paths[path] = { ...(paths[path] ?? {}), [r.method.toLowerCase()]: op };
  }
  const schemas: Record<string, unknown> = { ...BASE_SCHEMAS };
  if (tx) {
    const records: string[] = [];
    const schema = await loadSchema(tx);
    for (const o of schema.objects.values()) {
      if (!isModuleOn(schema, o)) continue;
      const properties: Record<string, unknown> = { id: { type: "string", readOnly: true }, display_name: { type: "string", readOnly: true } };
      for (const f of o.fields) {
        properties[f.api_name] = {
          ...(INPUT_SCHEMA[f.type] ?? FIELD_SCHEMA(f.type)),
          ...(f.type === "rating" ? { maximum: ratingMax(f) } : {}),
          ...(f.options.values ? { enum: f.options.values.map((v) => v.key) } : {}),
          ...(f.type === "relation" && f.options.cardinality === "many_to_many" ? { type: "array", items: { type: "string" } } : {}),
          ...(f.read_only ? { readOnly: true } : {}),
          ...(f.description ? { description: f.description } : {}),
          nullable: true,
        };
      }
      schemas[o.api_name] = {
        type: "object", description: o.description || o.label, properties,
        required: o.fields.filter((f) => f.required && !f.read_only).map((f) => f.api_name),
        "x-id-prefix": o.id_prefix,
      };
      schemas[`${o.api_name}_record`] = recordSchema(o);
      records.push(o.api_name);
    }
    // Records in responses: one schema per object, told apart by `object`.
    schemas.Record = { oneOf: records.map((n) => ref(`${n}_record`)), discriminator: { propertyName: "object", mapping: Object.fromEntries(records.map((n) => [n, `#/components/schemas/${n}_record`])) } };
  }
  return {
    openapi: "3.1.0",
    info: { title: "hl-crm-db API", version: "1", description: "Headless CRM API. Generated from the server's route registry and, when authenticated, the workspace schema. The sign-in endpoints under /auth (no credential needed) are described in docs/sign-in.md, and the OAuth endpoints for the MCP servers (/oauth, /.well-known) in docs/mcp/oauth.md, not here." },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer" },
        session: { type: "apiKey", in: "cookie", name: cookieNames().session, description: "A person's browser session (docs/sign-in.md). Requests that change something also need the X-CSRF-Token header from GET /v1/auth/session" },
        ...(oauthSettings() ? { mcpOAuth: MCP_OAUTH_SCHEME } : {}),
      },
      schemas,
    },
    paths,
  };
}
