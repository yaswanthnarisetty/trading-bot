import mongoose from "mongoose";
import { setServers } from "node:dns";
import { isIP } from "node:net";
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

  // MongoDB Atlas mongodb+srv lookups use Node's DNS resolver. A machine with
  // a broken local SRV resolver may opt into a process-local DNS server without
  // changing the system network configuration or the database URI.
  const dnsServers = process.env.MONGODB_DNS_SERVERS;
  if (dnsServers) {
    const servers = dnsServers.split(",").map(server => server.trim());
    if (servers.length > 2 || servers.some(server => !isIP(server))) {
      logger.error("MONGODB_DNS_SERVERS must contain one or two IP addresses");
      process.exit(1);
    }
    setServers(servers);
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
