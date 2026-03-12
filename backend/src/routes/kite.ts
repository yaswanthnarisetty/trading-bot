import fs from "fs";
import path from "path";
import { Router, type Request, type Response, type NextFunction } from "express";
import axios from "axios";
import {
  generateAccessToken,
  validateToken,
  isTokenValid,
  isMock,
  getAuthHeader,
} from "../services/KiteService";
import { logger } from "../utils/logger";
import { authMiddleware } from "./auth.middleware";

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the token expiry string.
 * Kite tokens are valid until 6:00 AM IST the following day.
 */
function getTokenExpiry(): string {
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ] as const;

  // Compute current IST date, then advance one day
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(Date.now() + istOffsetMs);
  const tomorrow = new Date(istNow);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  const day = DAYS[tomorrow.getUTCDay()];
  const month = MONTHS[tomorrow.getUTCMonth()];
  const date = tomorrow.getUTCDate();

  return `6:00 AM IST, ${day} ${month} ${date}`;
}

// ─── GET /api/kite/status ─────────────────────────────────────────────────────

/**
 * Returns the live Kite token status by calling validateToken().
 *
 * Response:
 *   tokenValid  — whether the current token passes Kite's /user/profile check
 *   dataMode    — "LIVE" when key is set and token valid, "MOCK" otherwise
 *   apiKey      — masked to last 4 chars e.g. "***fre0"
 *   tokenExpiry — "6:00 AM IST, Mon Mar 9"
 *   loginUrl    — Kite OAuth v3 URL for the token refresh flow
 *   message     — human-readable status string
 *   config      — active trading parameters from env
 */
async function handleStatus(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const apiKey = process.env.KITE_API_KEY ?? "";
    const maskedApiKey =
      apiKey.length > 4 ? `***${apiKey.slice(-4)}` : apiKey ? "****" : "not set";

    const mock = isMock();
    let tokenValid = false;

    if (!mock) {
      tokenValid = await validateToken();
    }

    const dataMode: "LIVE" | "MOCK" = !mock && tokenValid ? "LIVE" : "MOCK";
    const loginUrl = apiKey
      ? `https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}`
      : "";

    const message = mock
      ? "No API key configured — running in mock mode"
      : tokenValid
        ? "Token is valid"
        : "Token is expired or invalid — use the refresh flow below";

    const config = {
      tradingPhase: Number(process.env.TRADING_PHASE ?? 1),
      paperCapital: Number(process.env.PAPER_CAPITAL ?? 200000),
      minConfidence: Number(process.env.MIN_CONFIDENCE ?? 0.65),
      maxPositions: Number(process.env.MAX_POSITIONS ?? 3),
    };

    res.json({
      tokenValid,
      dataMode,
      apiKey: maskedApiKey,
      tokenExpiry: getTokenExpiry(),
      loginUrl,
      message,
      config,
    });
  } catch (error) {
    next(error);
  }
}

// ─── POST /api/kite/refresh ───────────────────────────────────────────────────

/**
 * Exchanges a one-time request_token for a fresh Kite access_token.
 *
 * 1. Calls generateAccessToken(requestToken) — computes SHA-256 checksum
 *    and POSTs to https://api.kite.trade/session/token
 * 2. Updates process.env.KITE_ACCESS_TOKEN in memory
 * 3. Persists new token to backend/.env (replaces KITE_ACCESS_TOKEN line)
 * 4. Calls validateToken() to confirm the new token works
 * 5. Returns { success: true, message: "Token refreshed. Valid until <expiry>" }
 *
 * Body: { requestToken: string }
 */
async function handleRefresh(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const raw = (req.body as Record<string, unknown>).requestToken;
    if (typeof raw !== "string" || !raw.trim()) {
      res.status(400).json({ success: false, error: "requestToken is required" });
      return;
    }
    const requestToken = raw.trim();

    const accessToken = await generateAccessToken(requestToken);

    // Update in-memory env immediately
    process.env.KITE_ACCESS_TOKEN = accessToken;

    // Persist to .env file so the token survives server restarts
    const envPath = path.join(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      let content = fs.readFileSync(envPath, "utf-8");
      if (/^KITE_ACCESS_TOKEN=.*/m.test(content)) {
        content = content.replace(
          /^KITE_ACCESS_TOKEN=.*/m,
          `KITE_ACCESS_TOKEN=${accessToken}`
        );
      } else {
        content += `\nKITE_ACCESS_TOKEN=${accessToken}`;
      }
      fs.writeFileSync(envPath, content, "utf-8");
      logger.info("KITE_ACCESS_TOKEN written to .env");
    } else {
      logger.warn(".env file not found — token updated in memory only");
    }

    // Confirm the new token passes Kite validation
    const ok = await validateToken();
    if (!ok) {
      res.status(400).json({
        success: false,
        error: "Token saved but Kite validation failed — check API key and secret",
      });
      return;
    }

    logger.info("Kite token refreshed and validated successfully");
    res.json({
      success: true,
      message: `Token refreshed. Valid until ${getTokenExpiry()}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Token refresh failed";
    logger.error("Kite token refresh failed", { message });
    res.status(400).json({ success: false, error: message });
  }
}

// ─── GET /api/kite/instrument-search ─────────────────────────────────────────

/**
 * Fetches the live Kite NFO instruments CSV and returns matching option contracts.
 * Useful for verifying the exact tradingsymbol format for any expiry date.
 *
 * Query params:
 *   symbol  — underlying name, e.g. "NIFTY" (required)
 *   expiry  — ISO date string, e.g. "2026-03-10" (optional, filters by expiry)
 *   strike  — number, e.g. "24000" (optional, filters by strike)
 *
 * Response: { instruments: Array<{ tradingsymbol, expiry, strike, optionType }> }
 */
async function handleInstrumentSearch(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : null;
    const expiryFilter = typeof req.query.expiry === "string" ? req.query.expiry : null;
    const strikeFilter = typeof req.query.strike === "string" ? Number(req.query.strike) : null;

    if (!symbol) {
      res.status(400).json({ error: "symbol query param is required" });
      return;
    }

    if (isMock()) {
      res.status(400).json({ error: "Kite API key not configured — cannot fetch instruments" });
      return;
    }

    const response = await axios.get("https://api.kite.trade/instruments/NFO", {
      headers: { "X-Kite-Version": "3", ...getAuthHeader() },
      responseType: "text",
      timeout: 15_000,
    });

    const csv = response.data as string;
    const lines = csv.split("\n");
    // CSV header: instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,...
    const header = lines[0]?.split(",") ?? [];
    const col = (name: string) => header.indexOf(name);
    const colTs   = col("tradingsymbol");
    const colExp  = col("expiry");
    const colStr  = col("strike");
    const colOpt  = col("instrument_type");

    const instruments: Array<{
      tradingsymbol: string;
      expiry: string;
      strike: number;
      optionType: string;
    }> = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line?.trim()) continue;
      const parts = line.split(",");
      const ts  = parts[colTs]?.trim() ?? "";
      const exp = parts[colExp]?.trim() ?? "";
      const str = Number(parts[colStr]?.trim() ?? "0");
      const opt = parts[colOpt]?.trim() ?? "";

      // Filter by underlying name prefix
      if (!ts.startsWith(symbol)) continue;
      // Filter by expiry if provided
      if (expiryFilter && exp !== expiryFilter) continue;
      // Filter by strike if provided
      if (strikeFilter !== null && str !== strikeFilter) continue;
      // Only options (CE/PE)
      if (opt !== "CE" && opt !== "PE") continue;

      instruments.push({ tradingsymbol: ts, expiry: exp, strike: str, optionType: opt });
    }

    instruments.sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike);

    logger.info(`Instrument search: ${instruments.length} results for ${symbol}`, {
      expiryFilter, strikeFilter,
    });

    res.json({ instruments: instruments.slice(0, 200) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Instrument search failed", { message });
    next(error);
  }
}

// ─── Route registration ───────────────────────────────────────────────────────

router.get("/status", authMiddleware, handleStatus);
router.post("/refresh", authMiddleware, handleRefresh);
router.get("/instrument-search", authMiddleware, handleInstrumentSearch);

export default router;
