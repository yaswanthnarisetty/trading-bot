import { MonitoringSessionModel } from "../models/MonitoringSession";
import { OptionsPositionModel } from "../models/OptionsPosition";
import { SignalLogModel } from "../models/SignalLog";
import { CryptoPositionModel } from "../models/CryptoPosition";
import { logger } from "../utils/logger";

/**
 * Creates all MongoDB indexes required by the trading system.
 * This centralizes index definitions so collections stay performant under production workloads.
 *
 * SignalLog: 1 write per tick per session = highest write volume.
 * OptionsPosition: queried by session + status constantly.
 * MonitoringSession: queried by status and recency for dashboards.
 * CryptoPosition: same query patterns as OptionsPosition.
 *
 * @returns A promise that resolves once all index creation promises complete.
 */
export async function createIndexes(): Promise<void> {
  try {
    await Promise.all([
      SignalLogModel.collection.createIndex({ sessionId: 1, timestamp: -1 }),
      SignalLogModel.collection.createIndex({ asset: 1, timestamp: -1 }),
      OptionsPositionModel.collection.createIndex({ sessionId: 1, status: 1 }),
      OptionsPositionModel.collection.createIndex({
        sessionId: 1,
        timestamp: -1,
      }),
      MonitoringSessionModel.collection.createIndex({ status: 1 }),
      MonitoringSessionModel.collection.createIndex({ createdAt: -1 }),
      CryptoPositionModel.collection.createIndex({ sessionId: 1, status: 1 }),
      CryptoPositionModel.collection.createIndex({ sessionId: 1, entryTimestamp: -1 }),
    ]);

    logger.info("MongoDB indexes created");
  } catch (error) {
    logger.error("Failed to create MongoDB indexes", { error });
    throw error;
  }
}

