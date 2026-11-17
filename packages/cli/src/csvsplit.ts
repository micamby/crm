import { CliError, EXIT } from "./errors.js";

/**
 * Splits CSV text into records without interpreting fields, so a large file can be sent in
 * chunks that each stay under the API's limits. The server parses each chunk properly; this only
 * needs to know where records end, which a quote can hide (a quoted field may span lines).
 */

export interface CsvRecord { text: string; line: number }

export function splitRecords(text: string): { header: CsvRecord | null; records: CsvRecord[] } {
  const s = text.startsWith("﻿") ? text.slice(1) : text;
  const out: CsvRecord[] = [];
  let start = 0;
  let line = 1;
  let startLine = 1;
  let quoted = false;
  const push = (end: number) => {
    const t = s.slice(start, end);
    if (t !== "") out.push({ text: t, line: startLine });
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') quoted = !quoted;
    else if (c === "\n" || c === "\r") {
      const crlf = c === "\r" && s[i + 1] === "\n";
      if (!quoted) {
        push(i);
        if (crlf) i++;
        line++;
        start = i + 1;
        startLine = line;
        continue;
      }
      if (!crlf) line++;
    }
  }
  if (quoted) throw new CliError("csv_invalid", `CSV line ${startLine}: a quoted field is not closed`, EXIT.usage);
  push(s.length);
  const [header, ...records] = out;
  return { header: header ?? null, records };
}

export interface Chunk { text: string; records: CsvRecord[] }

/** Groups records into chunks of at most `maxRows` rows and `maxBytes` bytes, each starting with the header. */
export function chunkRecords(header: CsvRecord, records: CsvRecord[], maxRows: number, maxBytes: number): Chunk[] {
  const chunks: Chunk[] = [];
  const headerBytes = Buffer.byteLength(header.text) + 2;
  let cur: CsvRecord[] = [];
  let bytes = headerBytes;
  const flush = () => {
    if (cur.length) chunks.push({ text: [header.text, ...cur.map((r) => r.text)].join("\r\n") + "\r\n", records: cur });
    cur = [];
    bytes = headerBytes;
  };
  for (const r of records) {
    const size = Buffer.byteLength(r.text) + 2;
    if (headerBytes + size > maxBytes) throw new CliError("csv_row_too_large", `CSV line ${r.line} is too large to send (over ${maxBytes} bytes)`, EXIT.usage);
    if (cur.length >= maxRows || bytes + size > maxBytes) flush();
    cur.push(r);
    bytes += size;
  }
  flush();
  return chunks;
}

/** Quotes a field when RFC 4180 requires it (for the error report the CLI writes). */
export function csvLine(fields: string[]): string {
  return `${fields.map((f) => (/[",\r\n]/.test(f) ? `"${f.replaceAll('"', '""')}"` : f)).join(",")}\r\n`;
}
