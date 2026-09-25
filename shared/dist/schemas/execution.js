"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tradingEventSchema = exports.eventPayloadSchema = exports.aggregateTypeSchema = exports.tradingEventTypeSchema = exports.executionScopeSchema = exports.tradingDateSchema = exports.nonnegativeMoneyMinorSchema = exports.moneyMinorSchema = exports.quantityUnitsSchema = exports.nonnegativeIntegerSchema = exports.identifierSchema = exports.orderSideSchema = exports.reservationStateSchema = exports.intentPurposeSchema = exports.positionIntegritySchema = exports.positionLifecycleSchema = exports.cancellationStateSchema = exports.knowledgeStateSchema = exports.orderPhaseSchema = exports.intentStateSchema = exports.executionModeSchema = void 0;
const zod_1 = require("zod");
/** Execution is independent of quote/data mode and of configured credentials. */
exports.executionModeSchema = zod_1.z.enum(["LEGACY_PAPER", "PAPER", "LIVE"]);
exports.intentStateSchema = zod_1.z.enum([
    "CREATED", "RISK_PENDING", "RISK_RESERVED", "EXECUTING", "COMPLETED",
    "BLOCKED", "ABORTING", "ABORTED",
]);
exports.orderPhaseSchema = zod_1.z.enum([
    "PLANNED", "READY", "SUBMITTING", "SUBMITTED", "ACKNOWLEDGED",
    "PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED", "NOT_SENT",
]);
exports.knowledgeStateSchema = zod_1.z.enum(["KNOWN", "UNKNOWN", "RECONCILIATION_REQUIRED"]);
exports.cancellationStateSchema = zod_1.z.enum([
    "NONE", "REQUESTED", "CANCEL_PENDING", "CONFIRMED", "REJECTED", "UNKNOWN",
]);
exports.positionLifecycleSchema = zod_1.z.enum([
    "PENDING_ENTRY", "PARTIALLY_OPENED", "OPEN", "CLOSING",
    "PARTIALLY_CLOSING", "CLOSED", "ABORTED",
]);
exports.positionIntegritySchema = zod_1.z.enum(["CONSISTENT", "RECONCILIATION_REQUIRED"]);
exports.intentPurposeSchema = zod_1.z.enum(["ENTRY", "CLOSE", "RECOVERY"]);
exports.reservationStateSchema = zod_1.z.enum(["HELD", "PARTIALLY_CONSUMED", "CONSUMED", "RELEASED"]);
exports.orderSideSchema = zod_1.z.enum(["BUY", "SELL"]);
exports.identifierSchema = zod_1.z.string().trim().min(1).max(200);
exports.nonnegativeIntegerSchema = zod_1.z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
exports.quantityUnitsSchema = exports.nonnegativeIntegerSchema;
/** INR paise in the new NSE ledger. Never legacy rupees or option points. */
exports.moneyMinorSchema = zod_1.z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
exports.nonnegativeMoneyMinorSchema = exports.moneyMinorSchema.refine(n => n >= 0, "Negative money balance");
exports.tradingDateSchema = zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Invalid trading date");
exports.executionScopeSchema = zod_1.z.object({
    accountId: exports.identifierSchema,
    executionMode: exports.executionModeSchema,
}).strict().refine(s => s.accountId.startsWith(`${s.executionMode}:`), {
    message: "Account IDs must be namespaced by their immutable execution mode",
});
exports.tradingEventTypeSchema = zod_1.z.enum([
    "SIGNAL_CREATED", "INTENT_CREATED", "RISK_BLOCKED", "RISK_RESERVED", "ENTRY_RISK_COMMITTED",
    "SUBMISSION_CLAIMED", "ORDER_SUBMITTED", "ORDER_ACKNOWLEDGED",
    "ORDER_READY", "ORDER_FINALITY_CONFIRMED", "INTENT_COMPLETED", "RESERVATION_CONSUMED",
    "ORDER_OUTCOME_UNKNOWN", "ORDER_REJECTED", "ORDER_CANCEL_REQUESTED", "ORDER_CANCELLED",
    "FILL_RECEIVED", "POSITION_PARTIALLY_OPENED", "POSITION_OPENED",
    "POSITION_CLOSE_REQUESTED", "POSITION_PARTIALLY_CLOSED", "POSITION_CLOSED",
    "RESERVATION_RELEASED", "RECONCILIATION_MISMATCH", "RECONCILIATION_RESOLVED",
    "ACCOUNT_HALTED", "ACCOUNT_RESUMED",
]);
exports.aggregateTypeSchema = zod_1.z.enum([
    "TradingAccount", "StrategySignal", "OrderIntent", "RiskReservation",
    "BrokerOrder", "Fill", "Position",
]);
exports.eventPayloadSchema = zod_1.z.discriminatedUnion("kind", [
    zod_1.z.object({
        kind: zod_1.z.literal("ENTRY_RISK_TRANSFER"), reservationId: exports.identifierSchema, fillId: exports.identifierSchema, legId: exports.identifierSchema,
        quantityUnits: exports.quantityUnitsSchema.refine(n => n > 0), releasedPendingMinor: exports.nonnegativeMoneyMinorSchema,
        committedPremiumMinor: exports.nonnegativeMoneyMinorSchema, remainingPendingMinor: exports.nonnegativeMoneyMinorSchema,
        committedExposureMinor: exports.nonnegativeMoneyMinorSchema, slotTransferred: zod_1.z.boolean(),
    }).strict(),
    zod_1.z.object({ kind: zod_1.z.literal("REFERENCE"), entityId: exports.identifierSchema }).strict(),
    zod_1.z.object({
        kind: zod_1.z.literal("STATE_CHANGE"), from: exports.identifierSchema.nullable(), to: exports.identifierSchema,
    }).strict(),
    zod_1.z.object({
        kind: zod_1.z.literal("FILL"), fillId: exports.identifierSchema, orderId: exports.identifierSchema,
        quantityUnits: exports.quantityUnitsSchema.refine(n => n > 0), priceMinor: exports.nonnegativeMoneyMinorSchema,
    }).strict(),
    zod_1.z.object({
        kind: zod_1.z.literal("RISK"), reservationId: exports.identifierSchema,
        marginMinor: exports.nonnegativeMoneyMinorSchema, exposureMinor: exports.nonnegativeMoneyMinorSchema,
    }).strict(),
]);
exports.tradingEventSchema = zod_1.z.object({
    eventId: exports.identifierSchema, accountId: exports.identifierSchema, executionMode: exports.executionModeSchema,
    accountSequence: exports.nonnegativeIntegerSchema.refine(n => n > 0),
    tradingDate: exports.tradingDateSchema, eventType: exports.tradingEventTypeSchema,
    aggregateType: exports.aggregateTypeSchema, aggregateId: exports.identifierSchema,
    aggregateVersion: exports.nonnegativeIntegerSchema, correlationId: exports.identifierSchema,
    causationId: exports.identifierSchema, actor: exports.identifierSchema, schemaVersion: zod_1.z.literal(1),
    occurredAt: zod_1.z.string().datetime(), recordedAt: zod_1.z.string().datetime(),
    reason: exports.identifierSchema, evidenceRefs: zod_1.z.array(exports.identifierSchema), payload: exports.eventPayloadSchema,
}).strict().superRefine((event, ctx) => {
    if (!exports.executionScopeSchema.safeParse({ accountId: event.accountId, executionMode: event.executionMode }).success) {
        ctx.addIssue({ code: "custom", message: "Invalid execution scope" });
    }
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
