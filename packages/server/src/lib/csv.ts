/**
 * CSV as RFC 4180 describes it: comma separated, fields quoted with double quotes when they hold
 * a comma, quote or line break, quotes doubled inside quoted fields, records ended by CRLF.
 * The parser also takes LF (and lone CR) line endings and a leading byte order mark, skips blank
 * lines, and rejects malformed quoting instead of guessing.
 */

export class CsvError extends Error {
  constructor(readonly line: number, message: string) {
    super(`CSV line ${line}: ${message}`);
  }
}

export interface ParsedCsv {
  rows: string[][];
  /** The line each row starts on (1-based), for error messages. */
  lines: number[];
}

export function parseCsv(text: string, opts: { maxRows?: number } = {}): ParsedCsv {
  const s = text.startsWith("﻿") ? text.slice(1) : text;
  const rows: string[][] = [];
  const lines: number[] = [];
  let line = 1;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const startLine = line;
    const row: string[] = [];
    let blank = true;
    // One record.
    for (;;) {
      let field = "";
      if (s[i] === '"') {
        blank = false;
        i++;
        for (;;) {
          if (i >= n) throw new CsvError(startLine, "a quoted field is not closed");
          const c = s[i]!;
          if (c === '"') {
            if (s[i + 1] === '"') {
              field += '"';
              i += 2;
              continue;
            }
            i++;
            break;
          }
          if (c === "\n" || (c === "\r" && s[i + 1] !== "\n")) line++;
          field += c;
          i++;
        }
        if (i < n && s[i] !== "," && s[i] !== "\r" && s[i] !== "\n") throw new CsvError(line, "unexpected text after a closing quote");
      } else {
        const start = i;
        while (i < n && s[i] !== "," && s[i] !== "\r" && s[i] !== "\n") {
          if (s[i] === '"') throw new CsvError(line, "a quote inside an unquoted field (quote the whole field and double the quote)");
          i++;
        }
        field = s.slice(start, i);
        if (field) blank = false;
      }
      row.push(field);
      if (i < n && s[i] === ",") {
        blank = false;
        i++;
        continue;
      }
      break;
    }
    // End of record: CRLF, LF, CR or end of input.
    if (s[i] === "\r") i += s[i + 1] === "\n" ? 2 : 1;
    else if (s[i] === "\n") i++;
    line++;
    if (blank) continue;
    rows.push(row);
    lines.push(startLine);
    if (opts.maxRows !== undefined && rows.length > opts.maxRows) throw new CsvError(startLine, `more than ${opts.maxRows} rows`);
  }
  return { rows, lines };
}

/** Quotes a field when RFC 4180 requires it. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function csvRow(fields: string[]): string {
  return `${fields.map(csvField).join(",")}\r\n`;
}

/**
 * Spreadsheets run a cell that starts with = + - @ (or tab or CR, which some strip first) as a
 * formula, so text exported for people to open in one gets a leading apostrophe. Import removes it.
 * So that removing it is an exact inverse, a value that already starts with apostrophes before one
 * of those characters ('+44, ''=x) gets one more as well: unguard(guard(s)) === s for every s.
 */
const GUARDED = /^'*[=+\-@\t\r]/;
export const guardFormula = (s: string): string => (GUARDED.test(s) ? `'${s}` : s);
export const unguardFormula = (s: string): string => (/^'+[=+\-@\t\r]/.test(s) ? s.slice(1) : s);
