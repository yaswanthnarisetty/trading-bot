import type { NextFunction, Request, Response } from "express";
import { logger } from "../utils/logger";

interface HttpError extends Error {
  statusCode?: number;
  status?: number;
}

/**
 * Global Express error handler middleware.
 * This logs full error details server-side while sending a safe, stack-free response to clients.
 *
 * @param err - The thrown or forwarded error object.
 * @param _req - The incoming HTTP request (unused but required by Express).
 * @param res - The HTTP response used to send the error payload.
 * @param _next - The next middleware function in the chain (unused here).
 */
export function errorHandler(
  err: HttpError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const statusCode = err.statusCode ?? err.status ?? 500;
  const isServerError = statusCode >= 500;
  const message = isServerError ? "Internal server error" : err.message;

  logger.error("Unhandled application error", {
    message: err.message,
    stack: err.stack,
    statusCode,
  });

  res.status(statusCode).json({
    error: message,
    code: statusCode,
  });
}

