import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import http from "http";
import { connectWithRetry } from "./db/connection";
import { createIndexes } from "./db/indexes";
import { errorHandler } from "./middleware/errorHandler";
import { logger } from "./utils/logger";
import assetsRouter from "./routes/assets";
import sessionRouter from "./routes/session";
import signalsRouter from "./routes/signals";
import positionsRouter from "./routes/positions";
import performanceRouter from "./routes/performance";
import backtestRouter from "./routes/backtest";
import kiteRouter from "./routes/kite";
import authRouter from "./routes/auth.routes";
import cryptoRouter from "./routes/crypto";
import { WebSocketService } from "./services/WebSocketService";
import { isMock, validateToken } from "./services/KiteService";
import { MonitoringSessionModel } from "./models/MonitoringSession";
import { ALLOWED_ASSETS, type AssetKey } from "./config/assets";
import {
  start as startSignalLoop,
  stop as stopSignalLoop,
} from "./services/SignalLoopService";
import {
  start as startPositionMonitor,
} from "./services/PositionMonitorService";


/**
 * Creates and configures the core Express application instance.
 * This sets baseline security, CORS, and JSON parsing used across all routes.
 *
 * @returns A configured Express application ready to be mounted on an HTTP server.
 */
function createApp(): express.Express {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin:[ 
      "https://app.yaswanthnarisetty.com",
      "http://localhost:3000",
      ],
      credentials: true,
    })
  );
  app.use(express.json());

  app.use("/api/assets", assetsRouter);
  app.use("/api/session", sessionRouter);
  app.use("/api/signals", signalsRouter);
  app.use("/api/positions", positionsRouter);
  app.use("/api/performance", performanceRouter);
  app.use("/api/backtest", backtestRouter);
  app.use("/api/kite", kiteRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/crypto", cryptoRouter);
  

  app.use(errorHandler);

  return app;
}

/**
 * Boots the HTTP server, connects to MongoDB, and initializes indexes.
 * This is the main entrypoint for the backend process in all environments.
 *
 * @returns A promise that resolves once the server is listening.
 */
async function bootstrap(): Promise<void> {
  const app = createApp();
  const server = http.createServer(app);

  const port = Number(process.env.PORT || 4000);
  const phase = process.env.TRADING_PHASE || "1";
  const dataMode = process.env.KITE_API_KEY ? "LIVE" : "MOCK";

  await connectWithRetry();
  await createIndexes();

  // Crash recovery: any session left RUNNING after a restart gets its loops resumed.
  // State is already in MongoDB — we just need to restart the in-memory timers.
  // If the asset is no longer valid, mark CRASHED so a new session can be started.
  const orphaned = await MonitoringSessionModel.find({ status: "RUNNING" }).exec();
  for (const session of orphaned) {
    const asset = session.asset;
    if (!(asset in ALLOWED_ASSETS)) {
      logger.warn(`⚠️ Orphaned session ${session.sessionId} has unknown asset "${asset}" — marking CRASHED`);
      session.status = "CRASHED";
      session.stopTime = new Date().toISOString();
      await session.save();
      continue;
    }
    try {
      logger.info(`🔄 Resuming orphaned session ${session.sessionId} (${asset}) after restart`);
      await startSignalLoop(session.sessionId, asset as AssetKey);
      startPositionMonitor(session.sessionId);
    } catch (err) {
      logger.error(`Failed to resume session ${session.sessionId} — marking CRASHED`, { err });
      session.status = "CRASHED";
      session.stopTime = new Date().toISOString();
      await session.save();
    }
  }

  WebSocketService.init(server);

  server.listen(port, () => {
    logger.info("Backend server started", {
      port,
      phase,
      dataMode,
      env: process.env.NODE_ENV || "development",
    });
  });

  // Validate Kite token on startup — non-blocking, server runs regardless of result.
  if (!isMock()) {
    validateToken()
      .then((ok) => {
        if (ok) {
          logger.info("Kite API connected ✅");
        } else {
          const apiKey = process.env.KITE_API_KEY ?? "";
          logger.warn(
            `⚠️ Kite token expired — refresh at kite.trade/connect/login?api_key=${apiKey}`
          );
          logger.warn("Falling back to mock data until token is refreshed");
        }
      })
      .catch((err: unknown) => {
        logger.error("Kite token check threw unexpectedly", { err });
      });
  } else {
    logger.info("KITE_API_KEY not set — running in mock data mode");
  }
}

void bootstrap();
