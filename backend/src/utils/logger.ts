import { createLogger, format, transports } from "winston";

const { combine, timestamp, colorize, printf, json } = format;

/**
 * Builds the Winston logger instance used across the backend.
 * This centralizes log formatting and transports so all components log consistently and safely.
 */
function buildLogger() {
  const isProduction = process.env.NODE_ENV === "production";

  const consoleFormat = isProduction
    ? combine(timestamp(), json())
    : combine(
        colorize(),
        timestamp(),
        printf((info) => {
          const { timestamp: ts, level, message, ...meta } = info;
          const metaString =
            Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
          return `${ts} [${level}]: ${message}${metaString}`;
        })
      );

  return createLogger({
    level: isProduction ? "info" : "debug",
    format: consoleFormat,
    transports: [new transports.Console()],
    defaultMeta: {},
  });
}

export const logger = buildLogger();

