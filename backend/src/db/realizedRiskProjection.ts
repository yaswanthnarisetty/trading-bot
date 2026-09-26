import type { ClientSession, Connection } from "mongoose";
import type { ExecutionScope } from "@trading-bot/shared";
import { verifyCloseLedger } from "../domain/closeWorkflowEvidence";
import { dailyPnl, realizedDays, realizedPosition, signedMinor, tradingDay } from "../domain/realizedRisk";
import { riskAssert } from "../domain/entryRisk";

type Row = Record<string, any>;
export async function loadRealizedProjection(connection: Connection, session: ClientSession, scope: ExecutionScope, calendar: unknown) {
  const db = connection.db!, holds = await db.collection("execution_reservations").find({ ...scope, kind: "ENTRY_RISK" }, { session }).toArray();
  const realizations: { executedAt: Date; pnlMinor: number }[] = []; let total = 0n;
  for (const hold of holds) {
    const pos = await db.collection("execution_positions").findOne({ ...scope, entryIntentId: hold.intentId }, { session });
    riskAssert(pos, "RISK_PROJECTION_MISMATCH");
    const orders = await db.collection("execution_orders").find({ ...scope, positionId: pos.positionId }, { session }).toArray();
    const fills = await db.collection("execution_fills").find({ ...scope, positionId: pos.positionId }, { session }).toArray();
    const intents = await db.collection("execution_intents").find({ ...scope, intentId: { $in: [...new Set([pos.entryIntentId, ...orders.map(o => o.intentId)])] } }, { session }).toArray();
    verifyCloseLedger(pos, orders, fills, intents);
    const pnl = realizedPosition(pos.entryIntentId, fills);
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
