import { reconciliationConfigSchema, reconciliationStateSchema } from "../domain/reconciliation";
import { tradingCalendarSchema, pnlDaysSchema } from "../domain/realizedRisk";
import { tradingDateSchema, identifierSchema } from "@trading-bot/shared";
import { z } from "zod";
import { model, Schema } from "mongoose";
import { entryRiskPolicySchema } from "../domain/entryRisk";
import { executionSchema, idField, moneyField, unitsField, writeOnceFields } from "./executionSupport";

export const TradingAccountSchema = executionSchema({
  broker: { type: String, enum: ["PAPER", "KITE", "LEGACY"], required: true, immutable: true },
  brokerAccountRef: idField(),
  // Explicit opt-in to comparison only; never changes PAPER broker ownership.
  reconciliationConfig: { type: Schema.Types.Mixed },
  reconciliationState: { type: Schema.Types.Mixed },
  currency: { type: String, enum: ["INR"], required: true, immutable: true },
  admissionStatus: { type: String, enum: ["DISABLED", "RECOVERING", "HALTED", "PAPER_READY"], required: true, default: "DISABLED" },
  // Explicit opt-in for isolated PAPER submission only; no LIVE readiness or credentials.
  policyVersion: unitsField(), executionEpoch: unitsField(),
  // Explicit durable opt-in; absent policy never inherits legacy env/session limits.
  entryRiskPolicy: { type: Schema.Types.Mixed },
  riskTradingCalendar: { type: Schema.Types.Mixed, immutable: true },
  dailyTradingDay: { type: String }, dailyRealizedPnlMinor: { ...moneyField(true), default: 0 },
  realizedPnlDays: { type: Schema.Types.Mixed, default: () => [] },
  killSwitchEnabled: { type: Boolean, required: true, default: false },
  killSwitchCommand: { type: Schema.Types.Mixed },
  reservedMarginMinor: moneyField(), reservedExposureMinor: moneyField(),
  committedExposureMinor: moneyField(), realizedPnlMinor: moneyField(true),
  // positionSlots remains TOTAL retained slots. Reserved slots = total - committed.
  committedPositionSlots: { ...unitsField(), default: 0 },
  positionSlots: unitsField(), nextEventSequence: unitsField(true),
}, "execution_accounts");
writeOnceFields(TradingAccountSchema, ["riskTradingCalendar", "reconciliationConfig"]);
TradingAccountSchema.index({ accountId: 1 }, { unique: true });
TradingAccountSchema.index({ broker: 1, brokerAccountRef: 1, executionMode: 1 }, { unique: true });
TradingAccountSchema.pre("validate", function () {
  if (this.get("reconciliationConfig") !== undefined && (this.get("executionMode") !== "PAPER"
    || !reconciliationConfigSchema.safeParse(this.get("reconciliationConfig")).success)) this.invalidate("reconciliationConfig", "Explicit PAPER shadow account required");
  if (this.get("reconciliationState") !== undefined && !reconciliationStateSchema.safeParse(this.get("reconciliationState")).success)
    this.invalidate("reconciliationState", "Invalid reconciliation state");
  if (this.get("riskTradingCalendar") !== undefined && !tradingCalendarSchema.safeParse(this.get("riskTradingCalendar")).success)
    this.invalidate("riskTradingCalendar", "Explicit IANA local-date calendar required");
  if (this.get("dailyTradingDay") !== undefined && !tradingDateSchema.safeParse(this.get("dailyTradingDay")).success)
    this.invalidate("dailyTradingDay", "Invalid trading-day key");
  if (!pnlDaysSchema.safeParse(this.get("realizedPnlDays")).success) this.invalidate("realizedPnlDays", "Invalid exact daily P&L");
  if (this.get("killSwitchCommand") !== undefined && !z.object({ commandId: identifierSchema, reason: identifierSchema,
    enabled: z.boolean(), changedAt: z.date() }).strict().safeParse(this.get("killSwitchCommand")).success)
    this.invalidate("killSwitchCommand", "Invalid audited kill command");
  if (Number(this.get("committedPositionSlots")) > Number(this.get("positionSlots")))
    this.invalidate("committedPositionSlots", "Committed slots exceed total slots");
  if (this.get("entryRiskPolicy") !== undefined && !entryRiskPolicySchema.safeParse(this.get("entryRiskPolicy")).success)
    this.invalidate("entryRiskPolicy", "Invalid persisted entry risk policy");
  if (this.get("admissionStatus") === "PAPER_READY" && this.get("executionMode") !== "PAPER")
    this.invalidate("admissionStatus", "PAPER_READY cannot enable another execution mode");
  const expected = this.get("executionMode") === "LIVE" ? "KITE" : this.get("executionMode") === "PAPER" ? "PAPER" : "LEGACY";
  if (this.get("broker") !== expected) this.invalidate("broker", "Broker does not belong to this execution mode");
});
export const TradingAccountModel = model("ExecutionTradingAccount", TradingAccountSchema);
