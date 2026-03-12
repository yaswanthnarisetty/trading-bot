import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { ALLOWED_ASSETS, type AssetKey } from "../config/assets";
import {
  getDefaultBacktestParams,
  runHistoricalBacktest,
} from "../services/BacktestService";
import type { HistoricalInterval } from "../services/KiteService";
import { authMiddleware } from "./auth.middleware";

const router = Router();

const ALLOWED_INTERVALS: HistoricalInterval[] = [
  "minute",
  "3minute",
  "5minute",
  "10minute",
  "15minute",
  "30minute",
  "60minute",
  "day",
];

function parseAsset(raw: unknown): AssetKey | null {
  const value = typeof raw === "string" ? raw : "";
  if (value in ALLOWED_ASSETS) {
    return value as AssetKey;
  }
  return null;
}

function parseInterval(raw: unknown): HistoricalInterval | null {
  if (typeof raw !== "string") {
    return null;
  }
  return ALLOWED_INTERVALS.includes(raw as HistoricalInterval)
    ? (raw as HistoricalInterval)
    : null;
}

function parseNumber(
  raw: unknown,
  fallback: number,
  min: number
): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    return fallback;
  }
  return value;
}

function parseDate(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

async function handleRunBacktest(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const asset = parseAsset(req.body?.asset);
    if (!asset) {
      res.status(400).json({ error: "Invalid asset", code: 400 });
      return;
    }

    const defaults = getDefaultBacktestParams(asset, {});
    const from = parseDate(req.body?.from) ?? defaults.from;
    const to = parseDate(req.body?.to) ?? defaults.to;

    if (new Date(from).getTime() >= new Date(to).getTime()) {
      res.status(400).json({ error: "'from' must be before 'to'", code: 400 });
      return;
    }

    const interval = parseInterval(req.body?.interval) ?? defaults.interval;

    const params = getDefaultBacktestParams(asset, {
      from,
      to,
      interval,
      initialCapital: parseNumber(req.body?.initialCapital, defaults.initialCapital, 1),
      riskPerTradePct: parseNumber(req.body?.riskPerTradePct, defaults.riskPerTradePct, 0.1),
      targetProfitPct: parseNumber(req.body?.targetProfitPct, defaults.targetProfitPct, 0.1),
      stopLossPct: parseNumber(req.body?.stopLossPct, defaults.stopLossPct, 0.1),
      maxHoldingBars: Math.floor(
        parseNumber(req.body?.maxHoldingBars, defaults.maxHoldingBars, 1)
      ),
      apiKey:
        typeof req.body?.kiteApiKey === "string" && req.body.kiteApiKey.trim()
          ? req.body.kiteApiKey.trim()
          : undefined,
      accessToken:
        typeof req.body?.kiteAccessToken === "string" && req.body.kiteAccessToken.trim()
          ? req.body.kiteAccessToken.trim()
          : undefined,
    });

    const result = await runHistoricalBacktest(params);
    res.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "backtest_failed";

    if (
      message.includes("Not enough historical candles") ||
      message.includes("Kite token expired") ||
      message.includes("Kite API key and access token are required")
    ) {
      res.status(400).json({ error: message, code: 400 });
      return;
    }

    next(error);
  }
}

router.post("/run", authMiddleware, handleRunBacktest);

export default router;
