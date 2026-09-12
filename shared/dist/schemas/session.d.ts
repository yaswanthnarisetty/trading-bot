import { z } from "zod";
/**
 * Zod schema describing a monitoring session for the options paper trading system.
 * This tracks lifecycle, performance, and configuration for a given trading session.
 */
export declare const monitoringSessionSchema: z.ZodObject<{
    executionMode: z.ZodOptional<z.ZodLiteral<"LEGACY_PAPER">>;
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
    dataMode: z.ZodEnum<["LIVE", "MOCK"]>;
}, "strip", z.ZodTypeAny, {
    status: "RUNNING" | "STOPPED" | "CRASHED";
    sessionId: string;
    asset: string;
    dataMode: "LIVE" | "MOCK";
    startTime: string;
    stopTime: string | null;
    totalSignals: number;
    totalTrades: number;
    winRate: number;
    paperPnL: number;
    paperCapital: number;
    ticksSkipped: number;
    executionMode?: "LEGACY_PAPER" | undefined;
}, {
    status: "RUNNING" | "STOPPED" | "CRASHED";
    sessionId: string;
    asset: string;
    dataMode: "LIVE" | "MOCK";
    startTime: string;
    stopTime: string | null;
    totalSignals: number;
    totalTrades: number;
    winRate: number;
    paperPnL: number;
    paperCapital: number;
    ticksSkipped: number;
    executionMode?: "LEGACY_PAPER" | undefined;
}>;
export type MonitoringSession = z.infer<typeof monitoringSessionSchema>;
//# sourceMappingURL=session.d.ts.map