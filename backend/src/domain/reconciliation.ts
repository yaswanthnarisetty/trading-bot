import { createHash } from "node:crypto";
import { z } from "zod";
import { identifierSchema as id, tradingDateSchema } from "@trading-bot/shared";
import type { BrokerAccountSnapshot, BrokerReadOrder } from "../brokers/KiteReadOnlyAdapter";

export const reconciliationConfigSchema = z.object({ kind: z.literal("PAPER_KITE_SHADOW_V1"), scope: z.literal("REFERENCE_ONLY"), brokerAccountId: id }).strict();
const instrument = z.object({ exchange: id, tradingsymbol: id, instrumentToken: z.string().regex(/^[1-9]\d*$/) }).strict();
export const reconciliationLinkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ORDER"), internalId: id, brokerKey: id, brokerOrderId: id,
    exchangeOrderId: id.nullable(), tradingDay: tradingDateSchema, instrument, product: id, internalProduct: id,
    positionScope: z.literal("ENTIRE_BROKER_NET_POSITION").optional() }).strict(),
  z.object({ kind: z.literal("FILL"), internalId: id, brokerKey: z.string().regex(/^[a-f0-9]{64}$/),
    orderLinkId: id, nativeTradeId: id }).strict(),
]);
export type ReconciliationLink = { linkId: string; brokerAccountId: string; evidenceRef: string; link: z.infer<typeof reconciliationLinkSchema> };
export const classificationSchema = z.enum(["MATCHED", "DISCREPANCY", "INCOMPLETE", "RECONCILIATION_REQUIRED"]);
const diagnosticEvidenceSchema = z.object({ brokerOrderId: id, instrumentKey: z.string().max(600), product: id,
  side: z.enum(["BUY", "SELL"]), nativeTradeId: id.optional(), brokerTradeKey: id.optional(),
  quantityUnits: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), price: z.string().max(400),
  executedAt: z.string().datetime().optional(), filledUnits: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  rawStatus: id.optional() }).strict();
export const discrepancySchema = z.object({ code: z.enum([
  "BROKER_ORDER_UNMAPPED", "INTERNAL_ORDER_NOT_CONFIRMED", "ORDER_QUANTITY_MISMATCH", "ORDER_ECONOMICS_CONFLICT",
  "ORDER_STATUS_CONFLICT", "UNKNOWN_BROKER_STATUS", "INTERNAL_EXECUTION_UNRESOLVED", "BROKER_TRADE_MISSING_INTERNAL_FILL",
  "INTERNAL_FILL_NOT_CONFIRMED", "TRADE_ECONOMICS_CONFLICT", "ORDER_TRADE_QUANTITY_MISMATCH", "POSITION_QUANTITY_MISMATCH",
  "EXTERNAL_BROKER_EXPOSURE", "INTERNAL_EXPOSURE_UNMAPPED", "INTERNAL_POSITION_PROJECTION_MISMATCH",
  "BROKER_EVIDENCE_INCOMPLETE", "HISTORICAL_EVIDENCE_UNAVAILABLE", "SNAPSHOT_TIME_UNRESOLVED", "LINK_INVALID",
]), reference: z.string().max(600), expected: z.string().max(600).optional(), observed: z.string().max(600).optional(), evidence: diagnosticEvidenceSchema.optional() }).strict();
export type Discrepancy = z.infer<typeof discrepancySchema>;
export const reconciliationStateSchema = z.object({ recordId: id, classification: classificationSchema,
  snapshotFetchedAt: z.string().datetime(), endpointTimes: z.array(z.string().datetime()).length(4),
  internalFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const fingerprint = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const istDay = (iso: string) => new Date(new Date(iso).getTime() + 19800000).toISOString().slice(0, 10);
export const orderKey = (exchange: string, day: string, orderId: string) => fingerprint([exchange, day, orderId]);
const safeUnits = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const scoped = { accountId: id, executionMode: z.literal("PAPER") };
const orderSchema = z.object({ ...scoped, orderId: id, positionId: id, legId: id, contractKey: id, side: z.enum(["BUY", "SELL"]),
  quantityUnits: safeUnits, filledUnits: safeUnits, limitPriceMinor: safeUnits, phase: id, knowledge: id, cancellation: id,
  submissionAuthorization: z.object({ product: id }).passthrough().optional() }).passthrough();
const fillSchema = z.object({ ...scoped, fillId: id, orderId: id, positionId: id, legId: id, contractKey: id,
  broker: z.literal("PAPER"), side: z.enum(["BUY", "SELL"]), quantityUnits: safeUnits.refine(n => n > 0), priceMinor: safeUnits,
  executedAt: z.date() }).passthrough();
const positionSchema = z.object({ ...scoped, positionId: id, integrity: id,
  legs: z.array(z.object({ legId: id, entrySide: z.enum(["BUY", "SELL"]), entryFilledUnits: safeUnits, exitFilledUnits: safeUnits,
    netQuantityUnits: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional() }).passthrough()) }).passthrough();
export interface ReconciliationLedger { orders: unknown[]; fills: unknown[]; positions: unknown[]; links: ReconciliationLink[] }
const exposureKey = (i: z.infer<typeof instrument>, product: string) => canonical([i.exchange, i.tradingsymbol, i.instrumentToken, product]);
const sameInstrument = (a: z.infer<typeof instrument>, b: z.infer<typeof instrument>) => exposureKey(a, "") === exposureKey(b, "");
const samePrice = (minor: number, decimal: string) => {
  const [whole, fraction = ""] = decimal.split(".");
  return !/[1-9]/.test(fraction.slice(2)) && BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0")) === BigInt(minor);
};
const statusCompatible = (phase: string, broker: BrokerReadOrder["state"]) =>
  ({ ACKNOWLEDGED: ["WORKING", "TRIGGER_PENDING"], SUBMITTED: ["WORKING", "TRIGGER_PENDING", "PENDING"],
    PARTIALLY_FILLED: ["PARTIALLY_FILLED"], FILLED: ["COMPLETE"], CANCELLED: ["CANCELLED"], REJECTED: ["REJECTED"] } as Record<string, string[]>)[phase]?.includes(broker) ?? false;

/** Pure comparison of PAPER shadow references. Links are explicit persisted attestations,
 * never discovered by economic similarity. No broker observations become ledger Fills. */
export function compareReconciliation(accountId: string, brokerAccountId: string, snapshot: BrokerAccountSnapshot,
  ledger: ReconciliationLedger, now: Date, previous?: z.infer<typeof reconciliationStateSchema>) {
  if (snapshot.broker !== "KITE" || snapshot.brokerAccountId !== brokerAccountId) throw new Error("BROKER_ACCOUNT_MISMATCH");
  const allOrders = ledger.orders.map(o => orderSchema.parse(o)), allFills = ledger.fills.map(f => fillSchema.parse(f)),
    allPositions = ledger.positions.map(p => positionSchema.parse(p));
  if ([...allOrders, ...allFills, ...allPositions].some(r => r.accountId !== accountId)) throw new Error("LEDGER_SCOPE_MISMATCH");
  const discrepancies: Discrepancy[] = [];
  const add = (code: Discrepancy["code"], reference: string, expected?: string | number | bigint, observed?: string | number | bigint, evidence?: z.infer<typeof diagnosticEvidenceSchema>) =>
    discrepancies.push(discrepancySchema.parse({ code, reference, ...(expected === undefined ? {} : { expected: String(expected) }),
      ...(observed === undefined ? {} : { observed: String(observed) }), ...(evidence === undefined ? {} : { evidence }) }));
  let incomplete = false, unresolved = false;
  const endpoints = [snapshot.orders, snapshot.trades, snapshot.positions, snapshot.funds];
  for (const endpoint of endpoints) {
    if (endpoint.brokerAccountId !== brokerAccountId || endpoint.broker !== "KITE") throw new Error("BROKER_ACCOUNT_MISMATCH");
    if (endpoint.availability !== "AVAILABLE") { incomplete = true; add("BROKER_EVIDENCE_INCOMPLETE", endpoint.endpoint, "AVAILABLE", endpoint.error.code); }
  }
  const times = [snapshot.startedAt, snapshot.fetchedAt, ...endpoints.map(e => e.fetchedAt)];
  if (times.some(t => !Number.isFinite(Date.parse(t)) || Date.parse(t) > now.getTime() || istDay(t) !== istDay(now.toISOString()))
    || Date.parse(snapshot.startedAt) > Date.parse(snapshot.fetchedAt)
    || endpoints.some(e => e.fetchedAt < snapshot.startedAt || e.fetchedAt > snapshot.fetchedAt)
    || (previous && endpoints.some((e, i) => e.fetchedAt < previous.endpointTimes[i]))
    || (previous && previous.classification !== "MATCHED" && endpoints.some((e, i) => e.fetchedAt <= previous.endpointTimes[i]))) {
    incomplete = true; add("SNAPSHOT_TIME_UNRESOLVED", snapshot.fetchedAt);
  }
  const links = ledger.links.map(l => ({ ...l, link: reconciliationLinkSchema.parse(l.link) }));
  const orderLinks = links.filter(l => l.link.kind === "ORDER");
  const fillLinks = links.filter(l => l.link.kind === "FILL");
  // REFERENCE_ONLY: a link opts in an exact order and its child executions, not
  // every PAPER execution or every activity in the user's brokerage account.
  const ownedOrderIds = new Set(orderLinks.map(l => l.link.internalId));
  const orders = allOrders.filter(o => ownedOrderIds.has(o.orderId));
  const fills = allFills.filter(f => ownedOrderIds.has(f.orderId) || fillLinks.some(l => l.link.internalId === f.fillId));
  const positions = allPositions.filter(p => orders.some(o => o.positionId === p.positionId));
  const brokerOrders = snapshot.orders.availability === "AVAILABLE" ? snapshot.orders.data.filter(o =>
    orderLinks.some(l => l.link.brokerKey === orderKey(o.instrument.exchange, o.orderTimestamp.raw.slice(0, 10), o.brokerOrderId))) : [];
  const brokerTrades = snapshot.trades.availability === "AVAILABLE" ? snapshot.trades.data.filter(t =>
    fillLinks.some(l => l.link.brokerKey === t.brokerTradeKey) || orderLinks.some(l => l.link.kind === "ORDER"
      && l.link.brokerOrderId === t.brokerOrderId && l.link.instrument.exchange === t.instrument.exchange && l.link.tradingDay === t.tradingDay)) : [];
  const ownedExposureKeys = new Set<string>();
  const matchedOrderIds = new Set<string>();
  for (const entry of orderLinks) {
    const link = entry.link; if (link.kind !== "ORDER") continue;
    const internal = orders.find(o => o.orderId === link.internalId);
    if (!internal || entry.brokerAccountId !== brokerAccountId || link.brokerKey !== orderKey(link.instrument.exchange, link.tradingDay, link.brokerOrderId)
      || internal.contractKey !== `${link.instrument.exchange}:${link.instrument.tradingsymbol}`
      || internal.submissionAuthorization?.product !== link.internalProduct) { add("LINK_INVALID", entry.linkId); continue; }
    matchedOrderIds.add(internal.orderId);
    if (link.positionScope === "ENTIRE_BROKER_NET_POSITION") ownedExposureKeys.add(exposureKey(link.instrument, link.product));
    const broker = brokerOrders.find(o => orderKey(o.instrument.exchange, o.orderTimestamp.raw.slice(0, 10), o.brokerOrderId) === link.brokerKey);
    if (!broker) {
      if (snapshot.orders.availability === "AVAILABLE") {
        if (link.tradingDay !== istDay(snapshot.orders.fetchedAt)) { incomplete = true; add("HISTORICAL_EVIDENCE_UNAVAILABLE", internal.orderId); }
        else add("INTERNAL_ORDER_NOT_CONFIRMED", internal.orderId);
      }
      continue;
    }
    if (!sameInstrument(link.instrument, broker.instrument) || link.product !== broker.product || internal.side !== broker.side
      || broker.orderType !== "LIMIT" || !samePrice(internal.limitPriceMinor, broker.limitPrice)
      || (link.exchangeOrderId !== null && broker.exchangeOrderId !== null && link.exchangeOrderId !== broker.exchangeOrderId))
      add("ORDER_ECONOMICS_CONFLICT", internal.orderId);
    if (internal.quantityUnits !== broker.requestedUnits || internal.filledUnits !== broker.filledUnits)
      add("ORDER_QUANTITY_MISMATCH", internal.orderId, `${internal.quantityUnits}/${internal.filledUnits}`, `${broker.requestedUnits}/${broker.filledUnits}`);
    if (broker.cancelledUnits !== null && BigInt(broker.cancelledUnits) + BigInt(broker.filledUnits) > BigInt(broker.requestedUnits))
      add("ORDER_QUANTITY_MISMATCH", internal.orderId, broker.requestedUnits, BigInt(broker.cancelledUnits) + BigInt(broker.filledUnits));
    if (broker.state !== "UNKNOWN" && internal.knowledge === "KNOWN" && !statusCompatible(internal.phase, broker.state)) add("ORDER_STATUS_CONFLICT", internal.orderId, internal.phase, broker.state);
    const total = fills.filter(f => f.orderId === internal.orderId).reduce((n, f) => n + BigInt(f.quantityUnits), 0n);
    if (total !== BigInt(internal.filledUnits)) add("ORDER_QUANTITY_MISMATCH", internal.orderId, total, internal.filledUnits);
  }
  for (const internal of orders) {
    if (internal.knowledge !== "KNOWN" || ["SUBMITTING"].includes(internal.phase) || ["UNKNOWN", "REQUESTED", "CANCEL_PENDING"].includes(internal.cancellation)) {
      unresolved = true; add("INTERNAL_EXECUTION_UNRESOLVED", internal.orderId);
    }
    if (!matchedOrderIds.has(internal.orderId) && (internal.filledUnits > 0 || !["PLANNED", "READY", "NOT_SENT"].includes(internal.phase)))
      add("INTERNAL_ORDER_NOT_CONFIRMED", internal.orderId);
  }
  for (const broker of brokerOrders) {
    const key = orderKey(broker.instrument.exchange, broker.orderTimestamp.raw.slice(0, 10), broker.brokerOrderId);
    if (!orderLinks.some(l => l.link.brokerKey === key && matchedOrderIds.has(l.link.internalId))) add("BROKER_ORDER_UNMAPPED", broker.brokerOrderId, undefined, undefined,
      { brokerOrderId: broker.brokerOrderId, instrumentKey: exposureKey(broker.instrument, broker.product), product: broker.product,
        side: broker.side, quantityUnits: broker.requestedUnits, filledUnits: broker.filledUnits, price: broker.limitPrice, rawStatus: broker.rawStatus });
    if (broker.state === "UNKNOWN") { unresolved = true; add("UNKNOWN_BROKER_STATUS", broker.brokerOrderId); }
    if (snapshot.trades.availability === "AVAILABLE") {
      const total = brokerTrades.filter(t => t.brokerOrderId === broker.brokerOrderId && t.instrument.exchange === broker.instrument.exchange
        && t.tradingDay === broker.orderTimestamp.raw.slice(0, 10)).reduce((n, t) => n + BigInt(t.quantityUnits), 0n);
      if (total !== BigInt(broker.filledUnits)) add("ORDER_TRADE_QUANTITY_MISMATCH", broker.brokerOrderId, broker.filledUnits, total);
    }
  }
  const linkedFills = new Set<string>();
  for (const trade of brokerTrades) {
    const evidence = { brokerOrderId: trade.brokerOrderId, nativeTradeId: trade.nativeTradeId, brokerTradeKey: trade.brokerTradeKey,
      instrumentKey: exposureKey(trade.instrument, trade.product), product: trade.product, side: trade.side,
      quantityUnits: trade.quantityUnits, price: trade.price, executedAt: trade.executedAt };
    const entry = links.find(l => l.link.kind === "FILL" && l.link.brokerKey === trade.brokerTradeKey);
    if (!entry || entry.link.kind !== "FILL") { add("BROKER_TRADE_MISSING_INTERNAL_FILL", trade.brokerTradeKey, undefined, undefined, evidence); continue; }
    const link = entry.link, fill = fills.find(f => f.fillId === link.internalId), parent = orderLinks.find(l => l.linkId === link.orderLinkId);
    if (!fill || !parent || parent.link.kind !== "ORDER" || !matchedOrderIds.has(parent.link.internalId) || fill.orderId !== parent.link.internalId
      || entry.brokerAccountId !== brokerAccountId) { add("LINK_INVALID", entry.linkId); continue; }
    linkedFills.add(fill.fillId);
    if (link.nativeTradeId !== trade.nativeTradeId || parent.link.brokerOrderId !== trade.brokerOrderId || parent.link.tradingDay !== trade.tradingDay
      || !sameInstrument(parent.link.instrument, trade.instrument) || parent.link.product !== trade.product
      || (parent.link.exchangeOrderId !== null && trade.exchangeOrderId !== null && parent.link.exchangeOrderId !== trade.exchangeOrderId)
      || fill.contractKey !== trade.contractKey || fill.side !== trade.side || fill.quantityUnits !== trade.quantityUnits
      || !samePrice(fill.priceMinor, trade.price) || fill.executedAt.toISOString() !== trade.executedAt)
      add("TRADE_ECONOMICS_CONFLICT", fill.fillId, canonical([fill.side, fill.quantityUnits, fill.priceMinor, fill.executedAt]), undefined, evidence);
  }
  if (snapshot.trades.availability === "AVAILABLE") for (const fill of fills) if (!linkedFills.has(fill.fillId)) {
    if (istDay(fill.executedAt.toISOString()) !== istDay(snapshot.trades.fetchedAt)) { incomplete = true; add("HISTORICAL_EVIDENCE_UNAVAILABLE", fill.fillId); }
    else add("INTERNAL_FILL_NOT_CONFIRMED", fill.fillId);
  }
  const expected = new Map<string, bigint>();
  for (const fill of fills) {
    const parent = orderLinks.find(l => l.link.internalId === fill.orderId && matchedOrderIds.has(fill.orderId));
    if (!parent || parent.link.kind !== "ORDER") { add("INTERNAL_EXPOSURE_UNMAPPED", fill.fillId); continue; }
    const key = exposureKey(parent.link.instrument, parent.link.product);
    if (ownedExposureKeys.has(key))
      expected.set(key, (expected.get(key) ?? 0n) + BigInt(fill.quantityUnits) * (fill.side === "BUY" ? 1n : -1n));
    if (!positions.some(p => p.positionId === fill.positionId && p.legs.some(l => l.legId === fill.legId))) add("INTERNAL_POSITION_PROJECTION_MISMATCH", fill.fillId);
  }
  for (const position of positions) {
    if (position.integrity !== "CONSISTENT") { unresolved = true; add("INTERNAL_EXECUTION_UNRESOLVED", position.positionId); }
    for (const leg of position.legs.filter(l => orders.some(o => o.positionId === position.positionId && o.legId === l.legId))) {
      // Validate the existing PAPER leg projection against ALL of its PAPER Fills.
      // Unlinked fills do not thereby become broker exposure or require Kite trades.
      const total = allFills.filter(f => f.positionId === position.positionId && f.legId === leg.legId)
        .reduce((n, f) => n + BigInt(f.quantityUnits) * (f.side === "BUY" ? 1n : -1n), 0n);
      const projection = (BigInt(leg.entryFilledUnits) - BigInt(leg.exitFilledUnits)) * (leg.entrySide === "BUY" ? 1n : -1n);
      if (total !== projection || (leg.netQuantityUnits !== undefined && total !== BigInt(leg.netQuantityUnits)))
        add("INTERNAL_POSITION_PROJECTION_MISMATCH", `${position.positionId}:${leg.legId}`, total, projection);
    }
  }
  if (snapshot.positions.availability === "AVAILABLE") {
    const actual = new Map<string, bigint>();
    for (const position of snapshot.positions.data.net) {
      const key = exposureKey(position.instrument, position.product), units = BigInt(position.quantityUnits);
      if (ownedExposureKeys.has(key)) actual.set(key, (actual.get(key) ?? 0n) + units);
    }
    for (const key of new Set([...actual.keys(), ...expected.keys()])) {
      const internal = expected.get(key) ?? 0n, broker = actual.get(key) ?? 0n;
      if (broker !== internal) add(internal === 0n && broker !== 0n ? "EXTERNAL_BROKER_EXPOSURE" : "POSITION_QUANTITY_MISMATCH", key, internal, broker);
    }
  }
  const unique = [...new Map(discrepancies.map(d => [canonical(d), d])).values()].sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const classification = incomplete ? "INCOMPLETE" : unique.some(d => !["INTERNAL_EXECUTION_UNRESOLVED", "UNKNOWN_BROKER_STATUS"].includes(d.code))
    ? "DISCREPANCY" : unresolved ? "RECONCILIATION_REQUIRED" : "MATCHED";
  return { classification, discrepancies: unique,
    counts: { internalOrders: orders.length, internalFills: fills.length, internalPositions: positions.length,
      brokerOrders: brokerOrders.length, brokerTrades: brokerTrades.length,
      brokerNetPositions: snapshot.positions.availability === "AVAILABLE"
        ? snapshot.positions.data.net.filter(p => ownedExposureKeys.has(exposureKey(p.instrument, p.product))).length : null } };
}
