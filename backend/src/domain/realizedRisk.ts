import { z } from "zod";
import { identifierSchema, moneyMinorSchema, quantityUnitsSchema, tradingDateSchema } from "@trading-bot/shared";
import { checkedRiskUnits, riskAssert } from "./entryRisk";

export const tradingCalendarSchema = z.object({ kind: z.literal("LOCAL_DATE_V1"), timeZone: z.string().min(1).refine(zone => {
  try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(new Date(0)); return true; } catch { return false; }
}) }).strict();
export const pnlDaysSchema = z.array(z.object({ tradingDay: tradingDateSchema, realizedPnlMinor: moneyMinorSchema }).strict())
  .refine(days => new Set(days.map(d => d.tradingDay)).size === days.length, "Duplicate trading day");
export function tradingDay(calendar: unknown, date: Date): string {
  const config = tradingCalendarSchema.safeParse(calendar);
  riskAssert(config.success && Number.isFinite(date.getTime()), "TRADING_DAY_CONFIG_REQUIRED");
  const parts = new Intl.DateTimeFormat("en", { timeZone: config.data.timeZone, calendar: "gregory", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return tradingDateSchema.parse(["year", "month", "day"].map(key => parts.find(p => p.type === key)!.value).join("-"));
}
export function signedMinor(value: bigint): number {
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("REALIZED_PNL_OVERFLOW");
  return Number(value);
}
const economicFill = z.object({ fillId: identifierSchema, intentId: identifierSchema, legId: identifierSchema,
  side: z.enum(["BUY", "SELL"]), quantityUnits: quantityUnitsSchema.refine(n => n > 0), priceMinor: quantityUnitsSchema,
  brokerNamespace: identifierSchema, brokerTradeKey: identifierSchema, executedAt: z.coerce.date() });
/** Gross weighted-average cost, NOT FIFO. Cumulative floor allocation preserves
 * every entry paise at full close. Canonical execution-time/trade-identity order
 * assigns residual paise deterministically, independent of delivery order.
 */
export function realizedPosition(entryIntentId: string, input: readonly unknown[]) {
  const fills = z.array(economicFill).parse(input);
  if (new Set(fills.map(f => f.fillId)).size !== fills.length) throw new Error("DUPLICATE_REALIZED_FILL");
  const legs: Record<string, number> = {}, realizations: { fillId: string; executedAt: Date; pnlMinor: number }[] = [];
  for (const legId of [...new Set(fills.map(f => f.legId))].sort()) {
    const own = fills.filter(f => f.legId === legId), entries = own.filter(f => f.intentId === entryIntentId);
    const exits = own.filter(f => f.intentId !== entryIntentId).sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime()
      || a.brokerNamespace.localeCompare(b.brokerNamespace) || a.brokerTradeKey.localeCompare(b.brokerTradeKey));
    if (entries.some(f => f.side !== "BUY") || exits.some(f => f.side !== "SELL")) throw new Error("UNSUPPORTED_REALIZED_SHAPE");
    const units = entries.reduce((n, f) => n + BigInt(f.quantityUnits), 0n);
    const cost = entries.reduce((n, f) => n + BigInt(f.quantityUnits) * BigInt(f.priceMinor), 0n);
    checkedRiskUnits(units); checkedRiskUnits(cost);
    let closed = 0n, allocated = 0n, pnl = 0n;
    for (const fill of exits) {
      closed += BigInt(fill.quantityUnits);
      if (!units || closed > units) throw new Error("REALIZED_OVER_CLOSE");
      const nextCost = cost * closed / units;
      const value = BigInt(fill.quantityUnits) * BigInt(fill.priceMinor) - (nextCost - allocated);
      realizations.push({ fillId: fill.fillId, executedAt: fill.executedAt, pnlMinor: signedMinor(value) });
      allocated = nextCost; pnl += value;
    }
    legs[legId] = signedMinor(pnl);
  }
  return { legs, realizations, realizedPnlMinor: signedMinor(Object.values(legs).reduce((n, v) => n + BigInt(v), 0n)) };
}
export function realizedDays(realizations: { executedAt: Date; pnlMinor: number }[], calendar: unknown) {
  const days = new Map<string, bigint>();
  for (const item of realizations) { const day = tradingDay(calendar, item.executedAt);
    days.set(day, (days.get(day) ?? 0n) + BigInt(item.pnlMinor)); }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([tradingDay, value]) => ({ tradingDay, realizedPnlMinor: signedMinor(value) }));
}
export function dailyPnl(days: z.infer<typeof pnlDaysSchema>, day: string): number {
  return days.find(item => item.tradingDay === day)?.realizedPnlMinor ?? 0;
}
export function dailyLossReached(pnl: number, maximum: number): boolean {
  moneyMinorSchema.parse(pnl); quantityUnitsSchema.refine(n => n > 0).parse(maximum);
  return BigInt(pnl) <= -BigInt(maximum);
}
export function releaseRisk(current: { pending: number; committed: number; slots: number; committedSlots: number },
  owned: { pending: number; committed: number; reservedSlots: number; committedSlots: number }) {
  for (const n of [...Object.values(current), ...Object.values(owned)]) quantityUnitsSchema.parse(n);
  const next = { pending: checkedRiskUnits(BigInt(current.pending) - BigInt(owned.pending)),
    committed: checkedRiskUnits(BigInt(current.committed) - BigInt(owned.committed)),
    slots: checkedRiskUnits(BigInt(current.slots) - BigInt(owned.reservedSlots) - BigInt(owned.committedSlots)),
    committedSlots: checkedRiskUnits(BigInt(current.committedSlots) - BigInt(owned.committedSlots)) };
  if (owned.reservedSlots + owned.committedSlots !== 1 || next.committedSlots > next.slots) throw new Error("SETTLEMENT_SLOT_MISMATCH");
  return next;
}
