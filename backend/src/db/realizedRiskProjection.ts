import type { ClientSession, Connection } from "mongoose";
import type { ExecutionScope } from "@trading-bot/shared";
import { verifyCloseLedger } from "../domain/closeWorkflowEvidence";
import { dailyPnl, realizedDays, realizedPosition, signedMinor, tradingDay } from "../domain/realizedRisk";
import { riskAssert } from "../domain/entryRisk";

type Row = Record<string, any>;
export async function loadRealizedProjection(connection: Connection, session: ClientSession, scope: ExecutionScope, calendar: unknown) {
  const db = connection.db!, holds = await db.collection("execution_reservations").find({ ...scope, kind: "ENTRY_RISK" }, { session }).toArray();
  const entryIds = holds.map(hold => hold.intentId);
  const positions = entryIds.length ? await db.collection("execution_positions").find({ ...scope,
    entryIntentId: { $in: entryIds } }, { session }).toArray() : [];
  const positionIds = positions.map(position => position.positionId);
  const orders = positionIds.length ? await db.collection("execution_orders").find({ ...scope,
    positionId: { $in: positionIds } }, { session }).toArray() : [];
  const fills = positionIds.length ? await db.collection("execution_fills").find({ ...scope,
    positionId: { $in: positionIds } }, { session }).toArray() : [];
  const relevantIntentIds = [...new Set([...entryIds, ...orders.map(order => order.intentId)])];
  const intents = relevantIntentIds.length ? await db.collection("execution_intents").find({ ...scope,
    intentId: { $in: relevantIntentIds } }, { session }).toArray() : [];
  const realizations: { executedAt: Date; pnlMinor: number }[] = []; let total = 0n;
  for (const hold of holds) {
    const owned = positions.filter(position => position.entryIntentId === hold.intentId);
    riskAssert(owned.length === 1, "RISK_PROJECTION_MISMATCH");
    const pos = owned[0]!;
    const ownOrders = orders.filter(order => order.positionId === pos.positionId);
    const ownFills = fills.filter(fill => fill.positionId === pos.positionId);
    const ownIntentIds = new Set([pos.entryIntentId, ...ownOrders.map(order => order.intentId)]);
    const ownIntents = intents.filter(intent => ownIntentIds.has(intent.intentId));
    verifyCloseLedger(pos, ownOrders, ownFills, ownIntents);
    const intent = ownIntents.find(item => item.intentId === pos.entryIntentId)!;
    const pnl = realizedPosition(pos.entryIntentId, ownFills, { targetLegs: intent.targetLegs, entryPlan: intent.entryPlan });
    riskAssert(pos.realizedPnlMinor === pnl.realizedPnlMinor
      && pos.legs.every((leg: Row) => leg.realizedPnlMinor === (pnl.legs[leg.legId] ?? 0)), "RISK_PROJECTION_MISMATCH");
    total += BigInt(pnl.realizedPnlMinor); realizations.push(...pnl.realizations);
  }
  return { realizedPnlMinor: signedMinor(total), days: calendar === undefined ? [] : realizedDays(realizations, calendar) };
}
export function assertRealizedProjection(account: Row, projection: Awaited<ReturnType<typeof loadRealizedProjection>>) {
  riskAssert(account.realizedPnlMinor === projection.realizedPnlMinor
    && JSON.stringify(account.realizedPnlDays ?? []) === JSON.stringify(projection.days)
    && (account.dailyRealizedPnlMinor ?? 0) === (account.dailyTradingDay ? dailyPnl(projection.days, account.dailyTradingDay) : 0), "RISK_PROJECTION_MISMATCH");
}
export function currentDailyState(account: Row, now: Date) {
  const day = tradingDay(account.riskTradingCalendar, now);
  riskAssert(!account.dailyTradingDay || day >= account.dailyTradingDay, "TRADING_DAY_REGRESSION");
  return { dailyTradingDay: day, dailyRealizedPnlMinor: dailyPnl(account.realizedPnlDays ?? [], day) };
}
// Only the audited control service may mutate an existing kill command/state.
const killWrites = new WeakSet<ClientSession>();
const dayWrites = new WeakSet<ClientSession>();
export const dayWriteAllowed = (session: ClientSession) => dayWrites.has(session);
export async function withDayWrite<T>(session: ClientSession, work: () => Promise<T>): Promise<T> {
  dayWrites.add(session); try { return await work(); } finally { dayWrites.delete(session); }
}
export const killWriteAllowed = (session: ClientSession) => killWrites.has(session);
export async function withKillWrite<T>(session: ClientSession, work: () => Promise<T>): Promise<T> {
  killWrites.add(session); try { return await work(); } finally { killWrites.delete(session); }
}
