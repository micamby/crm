import type { Runtime } from "./runtime.js";

type Tone = "add" | "change" | "remove" | "warn" | "dim" | "bold";
const CODES: Record<Tone, [number, number]> = { add: [32, 39], change: [33, 39], remove: [31, 39], warn: [33, 39], dim: [2, 22], bold: [1, 22] };

/**
 * Output. Results go to stdout; progress, warnings and errors go to stderr, so `crm … > file`
 * captures only the result. With --json, stdout gets exactly one JSON document (or NDJSON for
 * streams). Colour only on a terminal, never with NO_COLOR set or with --json.
 */
export class Out {
  readonly color: boolean;

  constructor(private readonly rt: Runtime, readonly json: boolean) {
    this.color = !json && rt.stdoutIsTTY && !rt.env.NO_COLOR && rt.env.TERM !== "dumb";
  }

  line(s = ""): void {
    this.rt.stdout(`${s}\n`);
  }

  /** A message for the person at the terminal, not part of the result. */
  info(s: string): void {
    this.rt.stderr(`${s}\n`);
  }

  /** JSON. C1 and bidi controls, which JSON leaves raw, are escaped: they can only be inside strings, so it stays the same JSON. */
  data(v: unknown): void {
    this.rt.stdout(`${JSON.stringify(v, null, 2).replace(/[\u0080-\u009f\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`);
  }

  /**
   * Text from the server written as it came (an export, a non-JSON response). On a terminal, control
   * characters other than \n and \t are dropped, so record content can't send escape sequences to it;
   * piped or redirected, the bytes pass through unchanged.
   */
  raw(s: string): void {
    this.rt.stdout(this.rt.stdoutIsTTY ? s.replace(UNSAFE, (c) => (c === "\n" || c === "\t" ? c : "")) : s);
  }

  paint(tone: Tone, s: string): string {
    if (!this.color) return s;
    const [on, off] = CODES[tone];
    return `\u001b[${on}m${s}\u001b[${off}m`;
  }

  /** A plain aligned table. Cells are flattened to one line so a value cannot break the layout. */
  table(rows: Record<string, unknown>[], columns: string[]): void {
    if (rows.length === 0) {
      this.line(this.paint("dim", "(none)"));
      return;
    }
    const text = (v: unknown) => (v === null || v === undefined ? "" : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v))
      .replace(/[\r\n\t]+/g, " ").replace(UNSAFE, "");
    const cells = rows.map((r) => columns.map((c) => text(r[c])));
    const widths = columns.map((c, i) => Math.min(60, Math.max(c.length, ...cells.map((r) => r[i]!.length))));
    const fit = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s.padEnd(w));
    this.line(this.paint("bold", columns.map((c, i) => fit(c.toUpperCase(), widths[i]!)).join("  ").trimEnd()));
    for (const r of cells) this.line(r.map((c, i) => fit(c, widths[i]!)).join("  ").trimEnd());
  }
}

/** C0 and C1 controls, and the bidi controls that make a terminal show text in another order than it is. */
const UNSAFE = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu;

/** Strips terminal control characters (all but \n) and bidi controls from text that came from the server before it is printed. */
export const clean = (s: string): string => s.replace(UNSAFE, (c) => (c === "\n" ? c : ""));
/** As `clean`, for text printed on one line (a name, a reason): newlines and tabs become spaces, so the text can't start a line of its own. */
export const cleanLine = (s: string): string => s.replace(/[\r\n\t]+/g, " ").replace(UNSAFE, "");
