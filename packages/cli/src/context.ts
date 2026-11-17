import { HlCrmClient } from "@hl-crm-db/sdk";
import { readConfig, type Remote } from "./config.js";
import { CliError, EXIT, usage } from "./errors.js";
import { Out } from "./output.js";
import { configDir, type Runtime } from "./runtime.js";

/** Options every command accepts. */
export interface Globals {
  json: boolean;
  /** False with --no-input. */
  input: boolean;
  yes: boolean;
  remote?: string;
  insecureHttp?: boolean;
}

export interface Connection {
  name: string | null;
  url: string;
  key: string;
  insecureHttp: boolean;
  /** Where the URL and key came from, for `auth status` and `doctor`. */
  source: { url: "env" | "config"; key: "env" | "config" };
}

/** What a command needs: the runtime, its parsed global options, output, and a way to get a client. */
export class Context {
  exitCode: number = EXIT.ok;
  readonly out: Out;

  constructor(readonly rt: Runtime, readonly g: Globals) {
    this.out = new Out(rt, g.json);
  }

  get configDir(): string {
    return configDir(this.rt.env);
  }

  /**
   * The connection to use: HLCRM_API_URL and HLCRM_API_KEY override the saved remote (--remote,
   * else the current one), each on its own, so CI can run without a config file. A saved key only
   * ever goes to its own server: HLCRM_API_URL without HLCRM_API_KEY must name the saved remote's origin.
   */
  connection(): Connection {
    const env = this.rt.env;
    const needConfig = !(env.HLCRM_API_URL && env.HLCRM_API_KEY);
    const config = needConfig ? readConfig(this.configDir) : { remotes: {} as Record<string, Remote>, current: undefined };
    const name = this.g.remote ?? config.current ?? null;
    if (this.g.remote && needConfig && !Object.hasOwn(config.remotes, this.g.remote)) {
      throw new CliError("unknown_remote", `No saved remote named "${this.g.remote}" (see crm remote list)`, EXIT.usage);
    }
    const saved = name && Object.hasOwn(config.remotes, name) ? config.remotes[name] : undefined;
    const url = env.HLCRM_API_URL || saved?.url;
    const key = env.HLCRM_API_KEY || saved?.key;
    if (!url || !key) {
      throw new CliError("not_logged_in", "Not logged in: run crm auth login --url <api url>, or set HLCRM_API_URL and HLCRM_API_KEY", EXIT.auth);
    }
    if (env.HLCRM_API_URL && !env.HLCRM_API_KEY && saved && originOf(env.HLCRM_API_URL) !== originOf(saved.url)) {
      throw new CliError("env_url_mismatch", `HLCRM_API_URL (${originOf(env.HLCRM_API_URL)}) is not where the saved remote "${name}" lives `
        + `(${originOf(saved.url)}), so its key is not sent there. Set HLCRM_API_KEY as well, or unset HLCRM_API_URL and use --remote`, EXIT.usage);
    }
    return {
      name: env.HLCRM_API_URL && env.HLCRM_API_KEY ? null : name, url, key,
      insecureHttp: Boolean(this.g.insecureHttp || (!env.HLCRM_API_URL && saved?.insecure_http) || env.HLCRM_INSECURE_HTTP === "1"),
      source: { url: env.HLCRM_API_URL ? "env" : "config", key: env.HLCRM_API_KEY ? "env" : "config" },
    };
  }

  client(conn: Connection = this.connection()): HlCrmClient {
    return makeClient(this.rt, conn.url, conn.key, conn.insecureHttp);
  }

  /** Asks before doing something; with --no-input (or no terminal) only --yes counts. Never treats silence as consent. */
  async confirm(question: string, why: string): Promise<void> {
    if (this.g.yes) return;
    if (!this.g.input || !this.rt.interactive) {
      throw new CliError("confirmation_required", `${why}. Pass --yes to confirm (nothing is asked with --no-input or without a terminal)`, EXIT.notConfirmed);
    }
    if (!(await this.rt.confirm(question))) throw new CliError("not_confirmed", "Cancelled; nothing was changed", EXIT.notConfirmed);
  }
}

/** scheme://host:port, which is what a key is sent to; anything unparseable stands for itself (and never matches a real URL). */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function makeClient(rt: Runtime, url: string, key: string, insecureHttp: boolean): HlCrmClient {
  try {
    return new HlCrmClient({ baseUrl: url, apiKey: key, surface: "cli", fetch: rt.fetch, allowInsecureHttp: insecureHttp, timeoutMs: 60_000 });
  } catch (e) {
    const msg = (e as Error).message.replace(/^hl-crm-db: /, "");
    throw usage(/https/.test(msg) ? `${msg}. For a private network you control, pass --insecure-http` : msg);
  }
}
