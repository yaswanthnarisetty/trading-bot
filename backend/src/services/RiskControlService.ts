import { createHash } from "node:crypto";
import type { Connection } from "mongoose";
import { executionScopeSchema, identifierSchema, type ExecutionScope } from "@trading-bot/shared";
import { executionModels } from "../db/executionModels";
import { assertExecutionIndexes } from "../db/executionIndexes";
import { assertRealizedProjection, currentDailyState, loadRealizedProjection, withDayWrite, withKillWrite } from "../db/realizedRiskProjection";
import { assertAccountEntryProjection, loadAccountEntryProjection } from "../db/entryRiskProjection";
import { riskAudit, saveRisk } from "./riskAudit";

/** Explicit durable PAPER controls only. Never changes admissionStatus or dispatches. */
export class RiskControlService {
  private readonly scope: ExecutionScope; private readonly models;
  constructor(private readonly connection: Connection, scope: ExecutionScope, private readonly clock: () => Date = () => new Date()) {
    this.scope = executionScopeSchema.parse(scope); if (scope.executionMode !== "PAPER") throw new Error("PAPER_ONLY");
    this.models = executionModels(connection);
  }
  async setKillSwitch(commandId: string, enabled: boolean, reason: string) {
    identifierSchema.parse(commandId); identifierSchema.parse(reason); if (typeof enabled !== "boolean") throw new Error("INVALID_KILL_STATE");
    await assertExecutionIndexes(this.connection); const session = await this.connection.startSession();
    const eventId = `kill:${createHash("sha256").update(JSON.stringify([this.scope.accountId, commandId])).digest("hex")}`;
    try { return await session.withTransaction(async () => {
      const account = await this.models.TradingAccount.findOne(this.scope).session(session).orFail();
      if (account.get("broker") !== "PAPER") throw new Error("PAPER_ONLY");
      const prior = await this.models.TradingEvent.findOne({ ...this.scope, eventId }).session(session);
      if (prior) {
        if (prior.get("payload.enabled") !== enabled || prior.get("payload.reason") !== reason) throw new Error("KILL_COMMAND_CONFLICT");
        return { enabled, replay: true };
      }
      const now = this.clock(); account.set({ killSwitchEnabled: enabled, killSwitchCommand: { commandId, enabled, reason, changedAt: now } });
      await withKillWrite(session, () => saveRisk(account, this.scope, session, now));
      await riskAudit(this.models, this.scope, session, now, { eventId, eventType: enabled ? "KILL_SWITCH_ENABLED" : "KILL_SWITCH_DISABLED",
        causationId: commandId, reason, payload: { kind: "KILL_SWITCH", commandId, enabled, reason },
        tradingDate: account.get("dailyTradingDay") ?? now.toISOString().slice(0, 10), evidenceRefs: [commandId] });
      return { enabled, replay: false };
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }); } finally { await session.endSession(); }
  }
  async advanceTradingDay() {
    await assertExecutionIndexes(this.connection); const session = await this.connection.startSession();
    try { return await session.withTransaction(async () => {
      const account = await this.models.TradingAccount.findOne(this.scope).session(session).orFail();
      if (account.get("broker") !== "PAPER") throw new Error("PAPER_ONLY");
      assertAccountEntryProjection(account.toObject(), await loadAccountEntryProjection(this.connection, session, this.scope));
      assertRealizedProjection(account.toObject(), await loadRealizedProjection(this.connection, session, this.scope, account.get("riskTradingCalendar")));
      const now = this.clock(), next = currentDailyState(account.toObject(), now), from = account.get("dailyTradingDay") ?? null;
      if (from === next.dailyTradingDay) return { ...next, changed: false };
      account.set(next); await withDayWrite(session, () => saveRisk(account, this.scope, session, now));
      await riskAudit(this.models, this.scope, session, now, { eventId: `day:${createHash("sha256").update(JSON.stringify([this.scope.accountId, next.dailyTradingDay])).digest("hex")}`,
        eventType: "TRADING_DAY_ADVANCED", causationId: this.scope.accountId, reason: "QUALIFIED_LOCAL_DAY",
        tradingDate: next.dailyTradingDay, evidenceRefs: ["LOCAL_DATE_V1"], payload: { kind: "TRADING_DAY", from, to: next.dailyTradingDay, realizedPnlMinor: next.dailyRealizedPnlMinor } });
      return { ...next, changed: true };
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }); } finally { await session.endSession(); }
  }
}
