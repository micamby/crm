import { ALL_SCOPES } from "../core/context.js";
import { RESOURCE_SCOPES, type ResourceName } from "./scopes.js";

/**
 * The discovery documents (ADR 0010). No database here: the MCP process serves the protected
 * resource documents too. `issuer` is PUBLIC_URL's origin exactly, which is where clients fetch it.
 */

/** OAuth 2.0 Authorization Server Metadata (RFC 8414), also served as /.well-known/openid-configuration for clients that look there. */
export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    registration_endpoint: `${issuer}/oauth/register`,
    scopes_supported: ALL_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    // Public clients, or clients that prove themselves with a key from their metadata document. No client secrets.
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    token_endpoint_auth_signing_alg_values_supported: ["RS256", "PS256", "ES256", "EdDSA"],
    revocation_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    revocation_endpoint_auth_signing_alg_values_supported: ["RS256", "PS256", "ES256", "EdDSA"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** OAuth 2.0 Protected Resource Metadata (RFC 9728) for one MCP endpoint. `ops:write` implies `ops:read`; `offline_access` is never listed. */
export function protectedResourceMetadata(resource: string, issuer: string, name: ResourceName) {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: RESOURCE_SCOPES[name],
    bearer_methods_supported: ["header"],
    resource_name: name === "ops" ? "hl-crm-db ops MCP server" : "hl-crm-db admin MCP server",
  };
}

/** Where a resource's metadata document lives: the well-known prefix inserted before the endpoint's path (RFC 9728 §3.1). */
export const resourceMetadataUrl = (mcpOrigin: string, name: ResourceName) => `${mcpOrigin}/.well-known/oauth-protected-resource/mcp/${name}`;
