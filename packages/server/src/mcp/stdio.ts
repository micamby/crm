import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HlCrmClient } from "@hl-crm-db/sdk";
import { buildAdminServer, buildOpsServer } from "./tools.js";

/** Local MCP over stdio, for clients that launch the server as a process. */
export async function runStdio(surface: "ops" | "admin", apiUrl: string, apiKey: string): Promise<void> {
  // apiUrl is operator configuration; the documented setup reaches the API over a Docker network at http://api:8787.
  const client = new HlCrmClient({ baseUrl: apiUrl, apiKey, surface: `${surface}-mcp`, allowInsecureHttp: true });
  const server = surface === "ops" ? buildOpsServer(client) : buildAdminServer(client);
  await server.connect(new StdioServerTransport());
}
