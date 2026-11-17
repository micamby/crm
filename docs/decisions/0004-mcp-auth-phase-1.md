# 0004: API keys for MCP in Phase 1; OAuth later (see ADR 0010)

Status: accepted (2026-10-30); the "Later" section was replaced by [ADR 0010](0010-oauth-for-mcp.md) (2026-11-16)

## Decision

The MCP endpoints accept a bearer hl-crm-db API key and call the API with that same key. This is not OAuth token passthrough: the key is an hl-crm-db credential issued for the hl-crm-db API.

The MCP process holds no database credentials or encryption keys. The admin endpoint requires the `admin` scope. The ops endpoint requires an `ops:*` scope, and the API refuses admin routes on the ops surface.

The surface is reported by the MCP server in the `X-Hlcrm-Surface` header. It is advisory: the client chooses it, so anyone holding a key can send any value. It narrows what a key does through the MCP servers but is not a security boundary. Authorization is the permission check in the API (see ADR 0007). Model-set arguments such as `confirm` and `dry_run` are not a boundary either. See [Prompt injection](../mcp/README.md#prompt-injection-what-protects-you-and-what-does-not) in the MCP reference for what protects an admin connection and what does not.

API keys on the MCP endpoints are unchanged by OAuth: a bearer value shaped like an hl-crm-db key takes this path.

## OAuth (built, ADR 0010)

The earlier plan here was kept in part and changed in part:

- Kept: tokens bound to the MCP server's resource URL (RFC 8707); PKCE S256 required; `iss` in authorization responses (RFC 9207); Client ID Metadata Documents, now with Dynamic Client Registration as a fallback because many clients still use it.
- Changed: no token exchange (RFC 8693). The MCP process sends the client's token to the API together with a secret only the two processes hold (`MCP_SERVICE_SECRET`), and the API refuses an OAuth token from anyone else, so the API remains the only place that checks it and a stolen MCP token is useless against `/v1`. The surface is fixed by the token's resource, not chosen by the client. ADR 0010 explains why.
