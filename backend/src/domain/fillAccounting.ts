export interface AccountingFill { quantityUnits: number; priceMinor: number; side: "BUY" | "SELL"; intentId: string }

/** Exact gross entry consideration and signed open units. Average price is the rational
 * entryNotionalMinor / entryFilledUnits; never round and accumulate per-fill averages.
 * Realized P&L and reservation settlement are deliberately not computed here.
 */
export function fillAccounting(fills: readonly AccountingFill[], entryIntentId: string) {
  let entryNotional = 0n, netQuantity = 0n;
  for (const fill of fills) {
    if (!Number.isSafeInteger(fill.quantityUnits) || fill.quantityUnits <= 0
      || !Number.isSafeInteger(fill.priceMinor) || fill.priceMinor < 0
      || !["BUY", "SELL"].includes(fill.side)) throw new Error("INVALID_FILL_ACCOUNTING");
    const quantity = BigInt(fill.quantityUnits);
    if (fill.intentId === entryIntentId) entryNotional += quantity * BigInt(fill.priceMinor);
    netQuantity += fill.side === "BUY" ? quantity : -quantity;
  }
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (entryNotional > max || netQuantity > max || netQuantity < -max) throw new Error("FILL_ACCOUNTING_OVERFLOW");
  return { entryNotionalMinor: Number(entryNotional), netQuantityUnits: Number(netQuantity) };
}
