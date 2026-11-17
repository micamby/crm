import { HlCrmError } from "@hl-crm-db/sdk";

/** Exit codes. Documented in docs/cli.md; scripts depend on them, so never renumber. */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  /** Not logged in, the key was refused, or it lacks a permission. */
  auth: 3,
  /** The server refused because of a conflict: schema drift, a version mismatch, a duplicate. */
  conflict: 4,
  /** `schema plan` found changes to apply. */
  changes: 5,
  /** A confirmation was needed and not given (--no-input without --yes, or answered no). */
  notConfirmed: 6,
} as const;

/** An error the CLI reports and exits with. `code` is stable and appears in --json output. */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exit: number = EXIT.failure,
    readonly extra: { status?: number; requestId?: string; details?: unknown } = {},
  ) {
    super(message);
  }
}

export const usage = (message: string) => new CliError("usage", message, EXIT.usage);

/** Maps an HTTP status to an exit code. */
export function exitForStatus(status: number): number {
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 409 || status === 412 || status === 428) return EXIT.conflict;
  return EXIT.failure;
}

/** Turns anything thrown into a CliError: API problems keep their code, detail and request ID. */
export function toCliError(e: unknown): CliError {
  if (e instanceof CliError) return e;
  if (e instanceof HlCrmError) {
    return new CliError(e.code, e.message, exitForStatus(e.status), { status: e.status, requestId: e.requestId, details: e.details });
  }
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === "TimeoutError") return new CliError("timeout", "The server did not answer in time");
  if (err?.name === "TypeError" && /fetch failed/i.test(err.message ?? "")) {
    return new CliError("network_error", `Could not reach the server${err.cause?.code ? ` (${err.cause.code})` : ""}`);
  }
  if (typeof err?.message === "string" && err.message.startsWith("hl-crm-db: ")) return usage(err.message.slice("hl-crm-db: ".length));
  return new CliError("error", err?.message ?? String(e));
}
