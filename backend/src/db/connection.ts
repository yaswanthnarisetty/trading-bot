import mongoose from "mongoose";
import { logger } from "../utils/logger";

/**
 * Delays execution for the specified number of milliseconds.
 * This helper is used between MongoDB connection retries to avoid tight retry loops.
 *
 * @param ms - Number of milliseconds to wait before resolving.
 * @returns A promise that resolves after the given delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Attempts to connect to MongoDB with retry logic.
 * This ensures transient connectivity issues at startup do not immediately crash the process.
 *
 * @param retries - Maximum number of connection attempts before giving up.
 * @param delay - Delay in milliseconds between retries.
 * @returns A promise that resolves when the connection is established or exits the process on failure.
 */
export async function connectWithRetry(
  retries = 5,
  delay = 3000
): Promise<void> {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    logger.error("MONGODB_URI is not defined in environment variables");
    process.exit(1);
  }

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await mongoose.connect(uri);
      logger.info("MongoDB connected");
      return;
    } catch (error) {
      logger.error("MongoDB connection failed", {
        attempt,
        retries,
        error,
      });

      if (attempt === retries) {
        logger.error("All MongoDB connection attempts exhausted, exiting");
        process.exit(1);
      }

      await sleep(delay);
    }
  }
}

