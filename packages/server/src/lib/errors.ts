/** An error that maps to an RFC 9457 problem response. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") => new ApiError(404, "not_found", `${what} not found`);
export const badRequest = (message: string, details?: unknown) => new ApiError(400, "invalid_request", message, details);
export const forbidden = (message: string) => new ApiError(403, "forbidden", message);
export const conflict = (message: string, details?: unknown) => new ApiError(409, "conflict", message, details);
export const unprocessable = (message: string, details?: unknown) => new ApiError(422, "validation_failed", message, details);

/**
 * How long one request may work inside its transaction before it gives up, for the requests that
 * do many writes in one (schema plan and apply, import, bulk changes, merges, the duplicate finder). Each statement also has a 5 s limit
 * (db/pool.ts); this bounds the whole, so one request can't hold its connection and locks for long.
 * Mutable for tests.
 */
export const WORK_BUDGET_MS = { schema: 20_000, import: 20_000, bulk: 20_000, merge: 20_000 };

/** A check to call between units of work: throws 503 once `ms` have passed since it was made. */
export function deadline(ms: number, what: string): () => void {
  const end = Date.now() + ms;
  return () => {
    if (Date.now() >= end) {
      throw new ApiError(503, "work_budget_exceeded", `${what} took longer than ${Math.round(ms / 1000)} s, so nothing was changed; split it into smaller requests`);
    }
  };
}

/**
 * A problem with how the server is set up (environment variables, the database roles) or how one of
 * its commands was called. The command line reports these as one plain line and exits 1: they are
 * expected, and a stack trace would only hide the message.
 */
export class ConfigError extends Error {
  override name = "ConfigError";
}
