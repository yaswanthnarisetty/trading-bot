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
import kiteRouter, { kiteCallback } from "./routes/kite";
import authRouter from "./routes/auth.routes";
import cryptoRouter from "./routes/crypto";
import { WebSocketService } from "./services/WebSocketService";
import { kiteSession } from "./services/KiteService";
import { MonitoringSessionModel } from "./models/MonitoringSession";
import { paperOrchestrator, paperExitMonitor, paperExitScheduler } from "./services/PaperOrchestrationRuntime";
import { bootstrapNsePaperAccount } from "./db/nsePaperStartup";
import mongoose from "mongoose";

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
  app.get("/kite/callback", kiteCallback);
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
  const dataMode = kiteSession.getMode();

  await connectWithRetry();
  await createIndexes();
  await bootstrapNsePaperAccount(mongoose.connection);

  await paperOrchestrator.initialize();
  // Restart never resumes entry timers. Existing financial ledgers remain intact;
  // an explicit recovery proof and explicit session start are required.
  await MonitoringSessionModel.updateMany({ status: "RUNNING" }, { $set: {
    status: "CRASHED", stopTime: new Date().toISOString(), blockingReason: "RECOVERY_REQUIRED",
  } });

  await paperExitMonitor.initialize();
  // Exposure management is independent of entry activation and survives session STOP.
  paperExitScheduler.start();
  WebSocketService.init(server);

  server.listen(port, () => {
    logger.info("Backend server started", {
      port,
      phase,
      dataMode,
      env: process.env.NODE_ENV || "development",
    });
  });

  logger.info("Kite session requires Settings login; market-data mode is explicit");
}

void bootstrap();
