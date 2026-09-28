import { z } from "zod";

/** Execution is independent of quote/data mode and of configured credentials. */
export const executionModeSchema = z.enum(["LEGACY_PAPER", "PAPER", "LIVE"]);
export const intentStateSchema = z.enum([
  "CREATED", "RISK_PENDING", "RISK_RESERVED", "EXECUTING", "COMPLETED",
  "BLOCKED", "ABORTING", "ABORTED",
]);
export const orderPhaseSchema = z.enum([
  "PLANNED", "READY", "SUBMITTING", "SUBMITTED", "ACKNOWLEDGED",
  "PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED", "NOT_SENT",
]);
export const knowledgeStateSchema = z.enum(["KNOWN", "UNKNOWN", "RECONCILIATION_REQUIRED"]);
export const cancellationStateSchema = z.enum([
  "NONE", "REQUESTED", "CANCEL_PENDING", "CONFIRMED", "REJECTED", "UNKNOWN",
]);
export const positionLifecycleSchema = z.enum([
  "PENDING_ENTRY", "PARTIALLY_OPENED", "OPEN", "CLOSING",
  "PARTIALLY_CLOSING", "CLOSED", "ABORTED",
]);
export const positionIntegritySchema = z.enum(["CONSISTENT", "RECONCILIATION_REQUIRED"]);
export const intentPurposeSchema = z.enum(["ENTRY", "CLOSE", "RECOVERY"]);
export const reservationStateSchema = z.enum(["HELD", "PARTIALLY_CONSUMED", "CONSUMED", "RELEASED"]);
export const orderSideSchema = z.enum(["BUY", "SELL"]);
export const identifierSchema = z.string().trim().min(1).max(200);
export const nonnegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const quantityUnitsSchema = nonnegativeIntegerSchema;
/** INR paise in the new NSE ledger. Never legacy rupees or option points. */
export const moneyMinorSchema = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
export const nonnegativeMoneyMinorSchema = moneyMinorSchema.refine(n => n >= 0, "Negative money balance");
export const tradingDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Invalid trading date");

export const executionScopeSchema = z.object({
  accountId: identifierSchema,
  executionMode: executionModeSchema,
}).strict().refine(s => s.accountId.startsWith(`${s.executionMode}:`), {
  message: "Account IDs must be namespaced by their immutable execution mode",
});

export type ExecutionMode = z.infer<typeof executionModeSchema>;
export type ExecutionScope = z.infer<typeof executionScopeSchema>;
export type IntentState = z.infer<typeof intentStateSchema>;
export type OrderPhase = z.infer<typeof orderPhaseSchema>;
export type KnowledgeState = z.infer<typeof knowledgeStateSchema>;
export type CancellationState = z.infer<typeof cancellationStateSchema>;
export type PositionLifecycle = z.infer<typeof positionLifecycleSchema>;
export type PositionIntegrity = z.infer<typeof positionIntegritySchema>;
export type IntentPurpose = z.infer<typeof intentPurposeSchema>;
export type OrderSide = z.infer<typeof orderSideSchema>;

export const tradingEventTypeSchema = z.enum([
  "SIGNAL_CREATED", "INTENT_CREATED", "RISK_BLOCKED", "RISK_RESERVED", "ENTRY_RISK_COMMITTED",
  "DAILY_PNL_UPDATED", "TRADING_DAY_ADVANCED", "KILL_SWITCH_ENABLED", "KILL_SWITCH_DISABLED", "ENTRY_RISK_SETTLED",
  "SUBMISSION_CLAIMED", "ORDER_SUBMITTED", "ORDER_ACKNOWLEDGED",
  "ORDER_READY", "ORDER_FINALITY_CONFIRMED", "INTENT_COMPLETED", "RESERVATION_CONSUMED",
  "ORDER_OUTCOME_UNKNOWN", "ORDER_REJECTED", "ORDER_CANCEL_REQUESTED", "ORDER_CANCELLED",
  "FILL_RECEIVED", "POSITION_PARTIALLY_OPENED", "POSITION_OPENED",
  "POSITION_CLOSE_REQUESTED", "POSITION_PARTIALLY_CLOSED", "POSITION_CLOSED",
  "RESERVATION_RELEASED", "RECONCILIATION_MISMATCH", "RECONCILIATION_RESOLVED",
  "RECOVERY_REQUIRED", "RECOVERY_READY",
  "ACCOUNT_HALTED", "ACCOUNT_RESUMED",
]);
export const aggregateTypeSchema = z.enum([
  "TradingAccount", "StrategySignal", "OrderIntent", "RiskReservation",
  "BrokerOrder", "Fill", "Position",
]);
export const eventPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("RECOVERY"), generation: quantityUnitsSchema.refine(n => n > 0),
    startupId: identifierSchema.optional(), commandKey: identifierSchema, recordId: identifierSchema.nullable() }).strict(),
  z.object({ kind: z.literal("DAILY_PNL"), fillId: identifierSchema, positionId: identifierSchema,
    tradingDay: tradingDateSchema.nullable(), realizedPnlMinor: moneyMinorSchema, dailyRealizedPnlMinor: moneyMinorSchema }).strict(),
  z.object({ kind: z.literal("TRADING_DAY"), from: tradingDateSchema.nullable(), to: tradingDateSchema,
    realizedPnlMinor: moneyMinorSchema }).strict(),
  z.object({ kind: z.literal("KILL_SWITCH"), commandId: identifierSchema, enabled: z.boolean(), reason: identifierSchema }).strict(),
  z.object({ kind: z.literal("RISK_SETTLEMENT"), positionId: identifierSchema, reservationId: identifierSchema,
    pendingReleasedMinor: nonnegativeMoneyMinorSchema, committedReleasedMinor: nonnegativeMoneyMinorSchema,
    reservedSlotsReleased: quantityUnitsSchema, committedSlotsReleased: quantityUnitsSchema }).strict(),
  z.object({
    kind: z.literal("ENTRY_RISK_TRANSFER"), reservationId: identifierSchema, fillId: identifierSchema, legId: identifierSchema,
    quantityUnits: quantityUnitsSchema.refine(n => n > 0), releasedPendingMinor: nonnegativeMoneyMinorSchema,
    committedPremiumMinor: nonnegativeMoneyMinorSchema, remainingPendingMinor: nonnegativeMoneyMinorSchema,
    committedExposureMinor: nonnegativeMoneyMinorSchema, slotTransferred: z.boolean(),
  }).strict(),
  z.object({ kind: z.literal("REFERENCE"), entityId: identifierSchema }).strict(),
  z.object({
    kind: z.literal("STATE_CHANGE"), from: identifierSchema.nullable(), to: identifierSchema,
  }).strict(),
  z.object({
    kind: z.literal("FILL"), fillId: identifierSchema, orderId: identifierSchema,
    quantityUnits: quantityUnitsSchema.refine(n => n > 0), priceMinor: nonnegativeMoneyMinorSchema,
  }).strict(),
  z.object({
    kind: z.literal("RISK"), reservationId: identifierSchema,
    marginMinor: nonnegativeMoneyMinorSchema, exposureMinor: nonnegativeMoneyMinorSchema,
  }).strict(),
]);
export const tradingEventSchema = z.object({
  eventId: identifierSchema, accountId: identifierSchema, executionMode: executionModeSchema,
  accountSequence: nonnegativeIntegerSchema.refine(n => n > 0),
  tradingDate: tradingDateSchema, eventType: tradingEventTypeSchema,
  aggregateType: aggregateTypeSchema, aggregateId: identifierSchema,
  aggregateVersion: nonnegativeIntegerSchema, correlationId: identifierSchema,
  causationId: identifierSchema, actor: identifierSchema, schemaVersion: z.literal(1),
  occurredAt: z.string().datetime(), recordedAt: z.string().datetime(),
  reason: identifierSchema, evidenceRefs: z.array(identifierSchema), payload: eventPayloadSchema,
}).strict().superRefine((event, ctx) => {
  if (["RECOVERY_REQUIRED", "RECOVERY_READY"].includes(event.eventType)
    && (event.payload.kind !== "RECOVERY" || event.aggregateType !== "TradingAccount" || event.aggregateId !== event.accountId
      || (event.payload.kind === "RECOVERY" && ((event.eventType === "RECOVERY_READY") !== (event.payload.recordId !== null)))
      || event.evidenceRefs.length === 0)) ctx.addIssue({ code: "custom", message: "Recovery event requires typed generation and transition evidence" });
  if (!executionScopeSchema.safeParse({ accountId: event.accountId, executionMode: event.executionMode }).success) {
    ctx.addIssue({ code: "custom", message: "Invalid execution scope" });
  }
  const kinds: Record<string, string> = { DAILY_PNL_UPDATED: "DAILY_PNL", TRADING_DAY_ADVANCED: "TRADING_DAY",
    KILL_SWITCH_ENABLED: "KILL_SWITCH", KILL_SWITCH_DISABLED: "KILL_SWITCH", ENTRY_RISK_SETTLED: "RISK_SETTLEMENT" };
  if (kinds[event.eventType] && (event.payload.kind !== kinds[event.eventType]
    || event.aggregateType !== (event.eventType === "ENTRY_RISK_SETTLED" ? "RiskReservation" : "TradingAccount")))
    ctx.addIssue({ code: "custom", message: "Risk control event requires its typed payload and aggregate" });
  if (event.eventType === "FILL_RECEIVED" && event.payload.kind !== "FILL") {
    ctx.addIssue({ code: "custom", message: "FILL_RECEIVED requires a FILL payload" });
  }
  if (event.eventType === "ENTRY_RISK_COMMITTED" && (event.payload.kind !== "ENTRY_RISK_TRANSFER"
    || event.aggregateType !== "RiskReservation" || event.aggregateId !== event.payload.reservationId || event.causationId !== event.payload.fillId)) {
    ctx.addIssue({ code: "custom", message: "ENTRY_RISK_COMMITTED requires owned reservation and Fill transfer payload" });
  }
  if (["ENTRY_RISK_COMMITTED", "FILL_RECEIVED", "POSITION_OPENED", "POSITION_CLOSED", "ORDER_ACKNOWLEDGED", "RECONCILIATION_RESOLVED",
    "ORDER_READY", "ORDER_FINALITY_CONFIRMED", "INTENT_COMPLETED", "RESERVATION_CONSUMED"].includes(event.eventType)
    && event.evidenceRefs.length === 0) {
    ctx.addIssue({ code: "custom", message: "This event requires evidence" });
  }
});
export type TradingEvent = z.infer<typeof tradingEventSchema>;
export type TradingEventType = z.infer<typeof tradingEventTypeSchema>;
