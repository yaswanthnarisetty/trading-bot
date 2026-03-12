import { z } from "zod";

/**
 * Zod schema describing a monitoring session for the options paper trading system.
 * This tracks lifecycle, performance, and configuration for a given trading session.
 */
export const monitoringSessionSchema = z.object({
  sessionId: z.string(),
  asset: z.string(),
  startTime: z.string(),
  stopTime: z.string().nullable(),
  status: z.enum(["RUNNING", "STOPPED", "CRASHED"]),
  totalSignals: z.number(),
  totalTrades: z.number(),
  winRate: z.number(),
  paperPnL: z.number(),
  paperCapital: z.number(),
  ticksSkipped: z.number(),
  dataMode: z.enum(["LIVE", "MOCK"]),
});

export type MonitoringSession = z.infer<typeof monitoringSessionSchema>;

