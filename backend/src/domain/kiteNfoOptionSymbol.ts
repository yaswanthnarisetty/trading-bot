/** Narrow routing-identity decoder, never an economic-contract constructor.
 * Supported modern Kite formats: underlying + YYMMM / YYMDD + integer strike + CE/PE.
 * Two-digit years are supported only in 2000–2099. No legacy/decimal-strike fallback. */
export interface ParsedKiteNfoOptionSymbol {
  readonly underlying: "NIFTY" | "BANKNIFTY" | "FINNIFTY";
  readonly expiryEncodingKind: "MONTHLY" | "WEEKLY";
  readonly yearMonth: string;
  readonly expiryDay: string | null;
  readonly strikeMinor: bigint;
  readonly optionType: "CE" | "PE";
}
const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
export function parseKiteNfoOptionSymbol(symbol: string): ParsedKiteNfoOptionSymbol | null {
  if (typeof symbol !== "string" || symbol.length > 100 || /[^A-Z0-9]/.test(symbol)) return null;
  const match = /^(BANKNIFTY|FINNIFTY|NIFTY)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|[1-9OND]\d{2})([1-9]\d*)(CE|PE)$/.exec(symbol);
  if (!match) return null;
  const [, underlying, year, encoding, strike, optionType] = match;
  const monthly = months.indexOf(encoding);
  const month = monthly >= 0 ? monthly + 1 : "123456789OND".indexOf(encoding[0]) + 1;
  const yearMonth = `20${year}-${String(month).padStart(2, "0")}`;
  const expiryDay = monthly >= 0 ? null : encoding.slice(1);
  if (expiryDay !== null) {
    const text = `${yearMonth}-${expiryDay}`, date = new Date(`${text}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) return null;
  }
  return Object.freeze({ underlying: underlying as ParsedKiteNfoOptionSymbol["underlying"],
    expiryEncodingKind: monthly >= 0 ? "MONTHLY" : "WEEKLY", yearMonth, expiryDay,
    strikeMinor: BigInt(strike) * 100n, optionType: optionType as "CE" | "PE" });
}
