import { z } from "zod";
/**
 * Zod schema describing a monitoring session for the options paper trading system.
 * This tracks lifecycle, performance, and configuration for a given trading session.
 */
export declare const monitoringSessionSchema: z.ZodObject<{
    executionMode: z.ZodOptional<z.ZodEnum<["LEGACY_PAPER", "PAPER"]>>;
    strategyFamily: z.ZodOptional<z.ZodEnum<["LONG_OPTION", "DEBIT_VERTICAL", "CREDIT_VERTICAL"]>>;
    accountId: z.ZodOptional<z.ZodString>;
    lastCycleOutcome: z.ZodOptional<z.ZodString>;
    blockingReason: z.ZodOptional<z.ZodString>;
    lastCycleAt: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodString;
    asset: z.ZodString;
    startTime: z.ZodString;
    stopTime: z.ZodNullable<z.ZodString>;
    status: z.ZodEnum<["RUNNING", "STOPPED", "CRASHED"]>;
    totalSignals: z.ZodNumber;
    totalTrades: z.ZodNumber;
    winRate: z.ZodNumber;
    paperPnL: z.ZodNumber;
    paperCapital: z.ZodNumber;
    ticksSkipped: z.ZodNumber;
    dataMode: z.ZodEnum<["LIVE", "MOCK", "KITE_REAL"]>;
}, "strip", z.ZodTypeAny, {
    status: "RUNNING" | "STOPPED" | "CRASHED";
    sessionId: string;
    asset: string;
    dataMode: "LIVE" | "MOCK" | "KITE_REAL";
    startTime: string;
    stopTime: string | null;
    totalSignals: number;
    totalTrades: number;
    winRate: number;
    paperPnL: number;
    paperCapital: number;
    ticksSkipped: number;
    accountId?: string | undefined;
    executionMode?: "LEGACY_PAPER" | "PAPER" | undefined;
    strategyFamily?: "LONG_OPTION" | "DEBIT_VERTICAL" | "CREDIT_VERTICAL" | undefined;
    lastCycleOutcome?: string | undefined;
    blockingReason?: string | undefined;
    lastCycleAt?: string | undefined;
}, {
    status: "RUNNING" | "STOPPED" | "CRASHED";
    sessionId: string;
    asset: string;
    dataMode: "LIVE" | "MOCK" | "KITE_REAL";
    startTime: string;
    stopTime: string | null;
    totalSignals: number;
    totalTrades: number;
    winRate: number;
    paperPnL: number;
    paperCapital: number;
    ticksSkipped: number;
    accountId?: string | undefined;
    executionMode?: "LEGACY_PAPER" | "PAPER" | undefined;
    strategyFamily?: "LONG_OPTION" | "DEBIT_VERTICAL" | "CREDIT_VERTICAL" | undefined;
    lastCycleOutcome?: string | undefined;
    blockingReason?: string | undefined;
    lastCycleAt?: string | undefined;
}>;
export type MonitoringSession = z.infer<typeof monitoringSessionSchema>;
//# sourceMappingURL=session.d.ts.map