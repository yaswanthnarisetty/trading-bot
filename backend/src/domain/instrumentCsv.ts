/** Strict RFC-style CSV: quoted commas/newlines, escaped quotes, LF/CRLF and BOM.
 * Structural errors fail the entire master; unsupported rows are filtered later. */
export function parseInstrumentCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  const fail = () => { throw new Error("INVALID_INSTRUMENT_CSV"); };
  const endField = () => { row.push(field); field = ""; closed = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (c === ',') endField();
    else if (c === '\n') endRow();
    else if (c === '\r') { if (text[++i] !== '\n') fail(); endRow(); }
    else if (c === '"') { if (field !== "" || closed) fail(); quoted = true; }
    else { if (closed) fail(); field += c; }
  }
  if (quoted) fail();
  if (field !== "" || row.length || closed) endRow();
  return rows;
}
