import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.HLCRM_MASTER_KEY ??= randomBytes(32).toString("base64");
process.env.BLOB_DIR = mkdtempSync(join(tmpdir(), "hlcrm-blobs-"));
// People sign-in is on in tests, at an https origin (cookies are Secure and __Host- prefixed).
process.env.PUBLIC_URL = "https://crm.test";
// OAuth for the MCP servers is on too (ADR 0010): the MCP endpoints as clients see them, and the secret the two processes share.
process.env.MCP_PUBLIC_URL = "https://mcp.test";
process.env.MCP_SERVICE_SECRET ??= randomBytes(32).toString("base64url");
// The web UI is off unless a test turns it on (test/web-ui.test.ts), so a built packages/web changes nothing here.
process.env.WEB_UI = "false";
