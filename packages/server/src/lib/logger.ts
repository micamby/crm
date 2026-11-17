import { pino, type DestinationStream, type LoggerOptions } from "pino";

/**
 * Structured logger. Anything that could carry a credential or CRM field values is removed
 * before the line is written: values, bodies and data by path, and credential-like keys
 * (secret, password, token, authorization, API key, cookie) at any depth.
 */

/** Keys whose values are credentials wherever they appear, e.g. `{ req: { headers: { Authorization } } }` or `webhook_secret`. */
const SECRET_KEY = /secret|passw(or)?d|token|authori[sz]ation|api[-_]?key|cookie|credential|private[-_]?key/i;
const MAX_DEPTH = 8;

/** A copy of `value` with credential-like keys censored at any depth. Plain objects and arrays only; cycles are cut. */
export function redactSecrets(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1, seen));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value; // Errors, Buffers, Dates: left to pino's serializers
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redactSecrets(v, depth + 1, seen);
  return out;
}

export function createLogger(dest?: DestinationStream) {
  const options: LoggerOptions = {
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: ["body", "*.body", "values", "*.values", "data", "*.data"],
      censor: "[redacted]",
    },
    formatters: { log: (obj: Record<string, unknown>) => redactSecrets(obj) as Record<string, unknown> },
    base: { service: "hl-crm-db" },
  };
  return dest ? pino(options, dest) : pino(options);
}

export const logger = createLogger();
