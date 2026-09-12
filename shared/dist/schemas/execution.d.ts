import { z } from "zod";
/** Execution is independent of quote/data mode and of configured credentials. */
export declare const executionModeSchema: z.ZodEnum<["LEGACY_PAPER", "PAPER", "LIVE"]>;
export declare const intentStateSchema: z.ZodEnum<["CREATED", "RISK_PENDING", "RISK_RESERVED", "EXECUTING", "COMPLETED", "BLOCKED", "ABORTING", "ABORTED"]>;
export declare const orderPhaseSchema: z.ZodEnum<["PLANNED", "READY", "SUBMITTING", "SUBMITTED", "ACKNOWLEDGED", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED", "NOT_SENT"]>;
export declare const knowledgeStateSchema: z.ZodEnum<["KNOWN", "UNKNOWN", "RECONCILIATION_REQUIRED"]>;
export declare const cancellationStateSchema: z.ZodEnum<["NONE", "REQUESTED", "CANCEL_PENDING", "CONFIRMED", "REJECTED", "UNKNOWN"]>;
export declare const positionLifecycleSchema: z.ZodEnum<["PENDING_ENTRY", "PARTIALLY_OPENED", "OPEN", "CLOSING", "PARTIALLY_CLOSING", "CLOSED", "ABORTED"]>;
export declare const positionIntegritySchema: z.ZodEnum<["CONSISTENT", "RECONCILIATION_REQUIRED"]>;
export declare const intentPurposeSchema: z.ZodEnum<["ENTRY", "CLOSE", "RECOVERY"]>;
export declare const reservationStateSchema: z.ZodEnum<["HELD", "PARTIALLY_CONSUMED", "CONSUMED", "RELEASED"]>;
export declare const orderSideSchema: z.ZodEnum<["BUY", "SELL"]>;
export declare const identifierSchema: z.ZodString;
export declare const nonnegativeIntegerSchema: z.ZodNumber;
export declare const quantityUnitsSchema: z.ZodNumber;
/** INR paise in the new NSE ledger. Never legacy rupees or option points. */
export declare const moneyMinorSchema: z.ZodNumber;
export declare const nonnegativeMoneyMinorSchema: z.ZodEffects<z.ZodNumber, number, number>;
export declare const tradingDateSchema: z.ZodEffects<z.ZodString, string, string>;
export declare const executionScopeSchema: z.ZodEffects<z.ZodObject<{
    accountId: z.ZodString;
    executionMode: z.ZodEnum<["LEGACY_PAPER", "PAPER", "LIVE"]>;
}, "strict", z.ZodTypeAny, {
    accountId: string;
    executionMode: "LEGACY_PAPER" | "PAPER" | "LIVE";
}, {
    accountId: string;
    executionMode: "LEGACY_PAPER" | "PAPER" | "LIVE";
}>, {
    accountId: string;
    executionMode: "LEGACY_PAPER" | "PAPER" | "LIVE";
}, {
    accountId: string;
    executionMode: "LEGACY_PAPER" | "PAPER" | "LIVE";
}>;
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
export declare const tradingEventTypeSchema: z.ZodEnum<["SIGNAL_CREATED", "INTENT_CREATED", "RISK_BLOCKED", "RISK_RESERVED", "SUBMISSION_CLAIMED", "ORDER_SUBMITTED", "ORDER_ACKNOWLEDGED", "ORDER_OUTCOME_UNKNOWN", "ORDER_REJECTED", "ORDER_CANCEL_REQUESTED", "ORDER_CANCELLED", "FILL_RECEIVED", "POSITION_PARTIALLY_OPENED", "POSITION_OPENED", "POSITION_CLOSE_REQUESTED", "POSITION_PARTIALLY_CLOSED", "POSITION_CLOSED", "RESERVATION_RELEASED", "RECONCILIATION_MISMATCH", "RECONCILIATION_RESOLVED", "ACCOUNT_HALTED", "ACCOUNT_RESUMED"]>;
export declare const aggregateTypeSchema: z.ZodEnum<["TradingAccount", "StrategySignal", "OrderIntent", "RiskReservation", "BrokerOrder", "Fill", "Position"]>;
export declare const eventPayloadSchema: z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
    kind: z.ZodLiteral<"REFERENCE">;
    entityId: z.ZodString;
}, "strict", z.ZodTypeAny, {
    kind: "REFERENCE";
    entityId: string;
}, {
    kind: "REFERENCE";
    entityId: string;
}>, z.ZodObject<{
    kind: z.ZodLiteral<"STATE_CHANGE">;
    from: z.ZodNullable<z.ZodString>;
    to: z.ZodString;
}, "strict", z.ZodTypeAny, {
    kind: "STATE_CHANGE";
    from: string | null;
    to: string;
}, {
    kind: "STATE_CHANGE";
    from: string | null;
    to: string;
}>, z.ZodObject<{
    kind: z.ZodLiteral<"FILL">;
    fillId: z.ZodString;
    orderId: z.ZodString;
    quantityUnits: z.ZodEffects<z.ZodNumber, number, number>;
    priceMinor: z.ZodEffects<z.ZodNumber, number, number>;
}, "strict", z.ZodTypeAny, {
    kind: "FILL";
    fillId: string;
    orderId: string;
    quantityUnits: number;
    priceMinor: number;
}, {
    kind: "FILL";
    fillId: string;
    orderId: string;
    quantityUnits: number;
    priceMinor: number;
}>, z.ZodObject<{
    kind: z.ZodLiteral<"RISK">;
    reservationId: z.ZodString;
    marginMinor: z.ZodEffects<z.ZodNumber, number, number>;
    exposureMinor: z.ZodEffects<z.ZodNumber, number, number>;
}, "strict", z.ZodTypeAny, {
    kind: "RISK";
    reservationId: string;
    marginMinor: number;
    exposureMinor: number;
}, {
    kind: "RISK";
    reservationId: string;
    marginMinor: number;
    exposureMinor: number;
}>]>;
export declare const tradingEventSchema: z.ZodEffects<z.ZodObject<{
    eventId: z.ZodString;
    accountId: z.ZodString;
    executionMode: z.ZodEnum<["LEGACY_PAPER", "PAPER", "LIVE"]>;
    accountSequence: z.ZodEffects<z.ZodNumber, number, number>;
    tradingDate: z.ZodEffects<z.ZodString, string, string>;
    eventType: z.ZodEnum<["SIGNAL_CREATED", "INTENT_CREATED", "RISK_BLOCKED", "RISK_RESERVED", "SUBMISSION_CLAIMED", "ORDER_SUBMITTED", "ORDER_ACKNOWLEDGED", "ORDER_OUTCOME_UNKNOWN", "ORDER_REJECTED", "ORDER_CANCEL_REQUESTED", "ORDER_CANCELLED", "FILL_RECEIVED", "POSITION_PARTIALLY_OPENED", "POSITION_OPENED", "POSITION_CLOSE_REQUESTED", "POSITION_PARTIALLY_CLOSED", "POSITION_CLOSED", "RESERVATION_RELEASED", "RECONCILIATION_MISMATCH", "RECONCILIATION_RESOLVED", "ACCOUNT_HALTED", "ACCOUNT_RESUMED"]>;
    aggregateType: z.ZodEnum<["TradingAccount", "StrategySignal", "OrderIntent", "RiskReservation", "BrokerOrder", "Fill", "Position"]>;
    aggregateId: z.ZodString;
    aggregateVersion: z.ZodNumber;
    correlationId: z.ZodString;
    causationId: z.ZodString;
    actor: z.ZodString;
    schemaVersion: z.ZodLiteral<1>;
    occurredAt: z.ZodString;
    recordedAt: z.ZodString;
    reason: z.ZodString;
    evidenceRefs: z.ZodArray<z.ZodString, "many">;
    payload: z.ZodDiscriminatedUnion<"kind", [z.ZodObject<{
        kind: z.ZodLiteral<"REFERENCE">;
        entityId: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        kind: "REFERENCE";
        entityId: string;
    }, {
        kind: "REFERENCE";
        entityId: string;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"STATE_CHANGE">;
        from: z.ZodNullable<z.ZodString>;
        to: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        kind: "STATE_CHANGE";
        from: string | null;
        to: string;
    }, {
        kind: "STATE_CHANGE";
        from: string | null;
        to: string;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"FILL">;
        fillId: z.ZodString;
        orderId: z.ZodString;
        quantityUnits: z.ZodEffects<z.ZodNumber, number, number>;
        priceMinor: z.ZodEffects<z.ZodNumber, number, number>;
    }, "strict", z.ZodTypeAny, {
        kind: "FILL";
        fillId: string;
        orderId: string;
        quantityUnits: number;
        priceMinor: number;
    }, {
        kind: "FILL";
        fillId: string;
        orderId: string;
        quantityUnits: number;
        priceMinor: number;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"RISK">;
        reservationId: z.ZodString;
        marginMinor: z.ZodEffects<z.ZodNumber, number, number>;
        exposureMinor: z.ZodEffects<z.ZodNumber, number, number>;
    }, "strict", z.ZodTypeAny, {
        kind: "RISK";
        reservationId: string;
        marginMinor: number;
        exposureMinor: number;
    }, {
        kind: "RISK";
        reservationId: string;
        marginMinor: number;
        exposureMinor: number;
    }>]>;
}, "strict", z.ZodTypeAny, {
    accountId: string;
    executionMode: "LEGACY_PAPER" | "PAPER" | "LIVE";
    eventId: string;
    accountSequence: number;
    tradingDate: string;
    eventType: "RISK_RESERVED" | "SIGNAL_CREATED" | "INTENT_CREATED" | "RISK_BLOCKED" | "SUBMISSION_CLAIMED" | "ORDER_SUBMITTED" | "ORDER_ACKNOWLEDGED" | "ORDER_OUTCOME_UNKNOWN" | "ORDER_REJECTED" | "ORDER_CANCEL_REQUESTED" | "ORDER_CANCELLED" | "FILL_RECEIVED" | "POSITION_PARTIALLY_OPENED" | "POSITION_OPENED" | "POSITION_CLOSE_REQUESTED" | "POSITION_PARTIALLY_CLOSED" | "POSITION_CLOSED" | "RESERVATION_RELEASED" | "RECONCILIATION_MISMATCH" | "RECONCILIATION_RESOLVED" | "ACCOUNT_HALTED" | "ACCOUNT_RESUMED";
    aggregateType: "TradingAccount" | "StrategySignal" | "OrderIntent" | "RiskReservation" | "BrokerOrder" | "Fill" | "Position";
    aggregateId: string;
    aggregateVersion: number;
    correlationId: string;
    causationId: string;
    actor: string;
    schemaVersion: 1;
    occurredAt: string;
    recordedAt: string;
    reason: string;
    evidenceRefs: string[];
    payload: {
        kind: "REFERENCE";
        entityId: string;
    } | {
        kind: "STATE_CHANGE";
        from: string | null;
        to: string;
    } | {
        kind: "FILL";
        fillId: string;
        orderId: string;
        quantityUnits: number;
        priceMinor: number;
    } | {
        kind: "RISK";
        reservationId: string;
        marginMinor: number;
        exposureMinor: number;
    };
}, {
    accountId: string;
    executionMode: "LEGACY_PAPER" | "PAPER" | "LIVE";
    eventId: string;
    accountSequence: number;
    tradingDate: string;
    eventType: "RISK_RESERVED" | "SIGNAL_CREATED" | "INTENT_CREATED" | "RISK_BLOCKED" | "SUBMISSION_CLAIMED" | "ORDER_SUBMITTED" | "ORDER_ACKNOWLEDGED" | "ORDER_OUTCOME_UNKNOWN" | "ORDER_REJECTED" | "ORDER_CANCEL_REQUESTED" | "ORDER_CANCELLED" | "FILL_RECEIVED" | "POSITION_PARTIALLY_OPENED" | "POSITION_OPENED" | "POSITION_CLOSE_REQUESTED" | "POSITION_PARTIALLY_CLOSED" | "POSITION_CLOSED" | "RESERVATION_RELEASED" | "RECONCILIATION_MISMATCH" | "RECONCILIATION_RESOLVED" | "ACCOUNT_HALTED" | "ACCOUNT_RESUMED";
    aggregateType: "TradingAccount" | "StrategySignal" | "OrderIntent" | "RiskReservation" | "BrokerOrder" | "Fill" | "Position";
    aggregateId: string;
    aggregateVersion: number;
    correlationId: string;
    causationId: string;
    actor: string;
    schemaVersion: 1;
    occurredAt: string;
    recordedAt: string;
    reason: string;
    evidenceRefs: string[];
    payload: {
        kind: "REFERENCE";
        entityId: string;
    } | {
        kind: "STATE_CHANGE";
        from: string | null;
        to: string;
    } | {
        kind: "FILL";
        fillId: string;
        orderId: string;
        quantityUnits: number;
        priceMinor: number;
    } | {
        kind: "RISK";
        reservationId: string;
        marginMinor: number;
        exposureMinor: number;
    };
}>, {
    accountId: string;
    executionMode: "LEGACY_PAPER" | "PAPER" | "LIVE";
    eventId: string;
    accountSequence: number;
    tradingDate: string;
    eventType: "RISK_RESERVED" | "SIGNAL_CREATED" | "INTENT_CREATED" | "RISK_BLOCKED" | "SUBMISSION_CLAIMED" | "ORDER_SUBMITTED" | "ORDER_ACKNOWLEDGED" | "ORDER_OUTCOME_UNKNOWN" | "ORDER_REJECTED" | "ORDER_CANCEL_REQUESTED" | "ORDER_CANCELLED" | "FILL_RECEIVED" | "POSITION_PARTIALLY_OPENED" | "POSITION_OPENED" | "POSITION_CLOSE_REQUESTED" | "POSITION_PARTIALLY_CLOSED" | "POSITION_CLOSED" | "RESERVATION_RELEASED" | "RECONCILIATION_MISMATCH" | "RECONCILIATION_RESOLVED" | "ACCOUNT_HALTED" | "ACCOUNT_RESUMED";
    aggregateType: "TradingAccount" | "StrategySignal" | "OrderIntent" | "RiskReservation" | "BrokerOrder" | "Fill" | "Position";
    aggregateId: string;
    aggregateVersion: number;
    correlationId: string;
    causationId: string;
    actor: string;
    schemaVersion: 1;
    occurredAt: string;
    recordedAt: string;
    reason: string;
    evidenceRefs: string[];
    payload: {
        kind: "REFERENCE";
        entityId: string;
    } | {
        kind: "STATE_CHANGE";
        from: string | null;
        to: string;
    } | {
        kind: "FILL";
        fillId: string;
        orderId: string;
        quantityUnits: number;
        priceMinor: number;
    } | {
        kind: "RISK";
        reservationId: string;
        marginMinor: number;
        exposureMinor: number;
    };
}, {
    accountId: string;
    executionMode: "LEGACY_PAPER" | "PAPER" | "LIVE";
    eventId: string;
    accountSequence: number;
    tradingDate: string;
    eventType: "RISK_RESERVED" | "SIGNAL_CREATED" | "INTENT_CREATED" | "RISK_BLOCKED" | "SUBMISSION_CLAIMED" | "ORDER_SUBMITTED" | "ORDER_ACKNOWLEDGED" | "ORDER_OUTCOME_UNKNOWN" | "ORDER_REJECTED" | "ORDER_CANCEL_REQUESTED" | "ORDER_CANCELLED" | "FILL_RECEIVED" | "POSITION_PARTIALLY_OPENED" | "POSITION_OPENED" | "POSITION_CLOSE_REQUESTED" | "POSITION_PARTIALLY_CLOSED" | "POSITION_CLOSED" | "RESERVATION_RELEASED" | "RECONCILIATION_MISMATCH" | "RECONCILIATION_RESOLVED" | "ACCOUNT_HALTED" | "ACCOUNT_RESUMED";
    aggregateType: "TradingAccount" | "StrategySignal" | "OrderIntent" | "RiskReservation" | "BrokerOrder" | "Fill" | "Position";
    aggregateId: string;
    aggregateVersion: number;
    correlationId: string;
    causationId: string;
    actor: string;
    schemaVersion: 1;
    occurredAt: string;
    recordedAt: string;
    reason: string;
    evidenceRefs: string[];
    payload: {
        kind: "REFERENCE";
        entityId: string;
    } | {
        kind: "STATE_CHANGE";
        from: string | null;
        to: string;
    } | {
        kind: "FILL";
        fillId: string;
        orderId: string;
        quantityUnits: number;
        priceMinor: number;
    } | {
        kind: "RISK";
        reservationId: string;
        marginMinor: number;
        exposureMinor: number;
    };
}>;
export type TradingEvent = z.infer<typeof tradingEventSchema>;
export type TradingEventType = z.infer<typeof tradingEventTypeSchema>;
//# sourceMappingURL=execution.d.ts.map