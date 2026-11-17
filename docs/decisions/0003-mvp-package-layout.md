# 0003: Two packages for the MVP instead of seven

Status: accepted (2026-10-30)

An early plan sketched separate packages for contracts, core, db, sdk, mcp, providers and testing. For the MVP these are folders inside `packages/server` (`api/`, `core/`, `db/`, `mcp/`, `providers/`, `worker/`), plus a separate `packages/sdk`, the REST client the MCP servers and the future CLI share.

The architectural rule is unchanged: business rules live only in `core/`, the API is the only enforcement point, and the MCP servers reach data only through the SDK over HTTP. Folders can become packages later without changing behavior.
