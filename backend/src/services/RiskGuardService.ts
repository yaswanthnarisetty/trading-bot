import type { PrimarySignal, ExpiryContext, OptionsPosition } from "@trading-bot/shared";
import {
  MIN_CONFIDENCE_DEFAULT,
  MAX_POSITIONS_DEFAULT,
  MAX_DAILY_LOSS_PCT_DEFAULT,
  MAX_DAILY_TRADES,
  SKIP_OPEN_MINUTES,
  ATR_MAX_ENTRY,
  RSI_ENTRY_MIN,
  RSI_ENTRY_MAX,
  RSI_SLOPE_MIN,
  VOLUME_RATIO_MIN,
  PCR_BEAR_MAX,
  PCR_BULL_MIN,
  MIN_CREDIT_PTS,
  CONFIDENCE_MORNING,
  CONFIDENCE_MIDDAY,
  CONFIDENCE_AFTERNOON,
  SR_MIN_RANGE_PTS,
  SR_PROXIMITY_PENALTY,
  SR_ATR_BUFFER,
} from "../config/constants";
import type { SRContext, BreakoutResult } from "../utils/indicators";
import {
  isMarketOpen,
  isAfterCutoff,
  isFridayGapRisk,
  isPreHolidayGapRisk,
  getISTDayOfWeek,
} from "../utils/marketHours";
import type { AssetKey } from "../config/assets";

export interface RiskGuardInput {
  signal: PrimarySignal;
  expiryContext: ExpiryContext;
  openPositions: number;
  /** Full list of currently OPEN positions — used for strategy/direction dedup checks. */
  openPositionsList: OptionsPosition[];
  /** Count of all positions entered today (any status) — used for daily trade limit. */
  todayTradeCount: number;
  dailyLossPct: number;
  paperCapital: number;
  asset: AssetKey;
  ivRank: number;
  // ── New entry-quality fields ──────────────────────────────────────────────
  /** Minutes elapsed since 9:15 IST market open. Used for opening block and confidence gate. */
  minutesSinceOpen: number;
  /** ATR(14) at signal time. Null during warmup. */
  atr: number | null;
  /** RSI(14) at signal time. */
  rsi: number;
  /** RSI change over last 3 bars. Null during warmup. */
  rsiSlope: number | null;
  /** Current volume vs 20-bar average. */
  volumeRatio: number;
  /** Put-Call Ratio from option chain. Defaults to 1.0 in backtest. */
  pcr: number;
  /** Net credit of the spread in points. 0 if signal is HOLD. */
  netCreditPts: number;
  /**
   * Support & Resistance context for the current tick.
   * Optional — if absent, all SR checks are skipped (backward-compatible with backtest).
   */
  srContext?: SRContext;
  /**
   * Breakout detection result from the last N candles.
   * Optional — if absent, breakout checks are skipped.
   */
  breakout?: BreakoutResult;
}

export interface RiskGuardResult {
  action: "SUGGEST" | "BLOCK";
  reason?: string;
}

/**
 * Resolves a numeric configuration value from environment variables with a default fallback.
 */
function resolveNumberConfig(envKey: string, defaultValue: number): number {
  const raw = process.env[envKey];
  if (!raw) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
    return defaultValue;
  }
  return parsed;
}

/**
 * Deterministic risk gate that decides whether a signal may lead to a trade.
 * If any hard rule triggers, the action is BLOCK with a specific machine-readable reason.
 *
 * Rule order (first match wins):
 *   1.  Market closed
 *   2.  After cutoff (15:00 IST)
 *   3.  Opening minutes block (first 15 min)
 *   4.  ATR too high (excess volatility)
 *   5.  Tuesday after 13:00 — NIFTY gamma risk window
 *   6.  Friday after 14:00 — weekend gap risk
 *   7.  Pre-holiday after 14:00 — gap risk
 *   8.  Mon/Tue expiry-week: confidence floor raised to 0.75 (both directions allowed)
 *   9.  Extreme IV spike
 *   10. Signal is HOLD
 *   11. Time-based confidence threshold (replaces flat 65%/75%)
 *   12. RSI entry zone (exhaustion filter)
 *   13. RSI slope too weak (momentum confirmation)
 *   14. Volume too low (participation filter)
 *   15. PCR extreme (option chain lopsided)
 *   16. LLM parsing/timeout flags
 *   17. Duplicate strategy — same strategy already open
 *   18. Same direction — any open position in the same direction
 *   19. Daily trade limit (MAX_DAILY_TRADES per day)
 *   20. Max open positions
 *   21. Daily loss limit
 *   22. Minimum credit (spread must yield >= MIN_CREDIT_PTS)
 *
 * @param input - Current signal, expiry context, portfolio risk state, and market filters.
 * @returns A RiskGuardResult describing whether to SUGGEST or BLOCK the trade.
 */
export function evaluateRisk(input: RiskGuardInput): RiskGuardResult {
  const minConfidence = resolveNumberConfig("MIN_CONFIDENCE", MIN_CONFIDENCE_DEFAULT);
  const maxPositions = resolveNumberConfig("MAX_POSITIONS", MAX_POSITIONS_DEFAULT);
  const maxDailyLossPct = resolveNumberConfig("MAX_DAILY_LOSS_PCT", MAX_DAILY_LOSS_PCT_DEFAULT);

  // 1. Market closed
  if (!isMarketOpen()) {
    return { action: "BLOCK", reason: "market_closed" };
  }

  // 2. After cutoff — no new positions
  if (isAfterCutoff()) {
    return { action: "BLOCK", reason: "no_new_positions_after_cutoff" };
  }
  console.log(`RiskGuard: minutesSinceOpen=${input.minutesSinceOpen}, atr=${input.atr}, rsi=${input.rsi}, rsiSlope=${input.rsiSlope}, volumeRatio=${input.volumeRatio}, pcr=${input.pcr}, netCreditPts=${input.netCreditPts.toFixed(1)}`);

  // 3. Opening minutes block — first SKIP_OPEN_MINUTES after 9:15 IST market open.
  // Anchored to today's 9:15 AM IST (UTC+5:30 = 03:45:00 UTC), not session start time.
  // If session starts after 9:30 AM, minutesSinceMarketOpen >= 15 and this never triggers.
  const nowMs = Date.now();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(nowMs + istOffsetMs);
  const marketOpenMs = Date.UTC(
    istNow.getUTCFullYear(),
    istNow.getUTCMonth(),
    istNow.getUTCDate(),
    3, 45, 0, 0  // 09:15 IST = 03:45 UTC
  );
  const minutesSinceMarketOpen = (nowMs - marketOpenMs) / 60_000;
  if (minutesSinceMarketOpen < SKIP_OPEN_MINUTES) {
    return { action: "BLOCK", reason: "opening_volatility" };
  }

  // 4. ATR too high — underlying is whipsawing, credit spread edges erode
  if (input.atr !== null && input.atr > ATR_MAX_ENTRY) {
    return { action: "BLOCK", reason: `high_volatility_atr:${input.atr.toFixed(1)}` };
  }

  const dow = getISTDayOfWeek(); // 0=Sun, 1=Mon, 2=Tue ... 6=Sat
  const now = new Date();
  const hour = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })).getHours();

  // 5. Tuesday after 13:00 — NIFTY weekly expiry gamma risk
  if (dow === 2 && hour >= 13) {
    return { action: "BLOCK", reason: "expiry_afternoon_block" };
  }

  // 6. Friday after 14:00 — weekend gap risk
  if (isFridayGapRisk()) {
    return { action: "BLOCK", reason: "friday_gap_risk" };
  }

  // 7. Pre-holiday after 14:00 — gap risk
  if (isPreHolidayGapRisk()) {
    return { action: "BLOCK", reason: "pre_holiday_gap_risk" };
  }

  // 8. Mon/Tue expiry-week: mark flag used by rule 11 to raise confidence floor to 0.75.
  // No direction restriction — both BULL_PUT_SPREAD and BEAR_CALL_SPREAD are allowed.
  const isExpiryWeekEnd = dow === 1 || dow === 2;

  // 9. Extreme IV spike
  if (input.ivRank > 85) {
    return { action: "BLOCK", reason: "extreme_iv_spike" };
  }

  // 10. Signal is HOLD
  if (input.signal.strategy === "HOLD") {
    return { action: "BLOCK", reason: "signal_is_hold" };
  }

  const isBear = input.signal.strategy === "BEAR_CALL_SPREAD";
  const isBull = input.signal.strategy === "BULL_PUT_SPREAD";

  // 10b. Breakout alignment — boost confidence +0.10 when breakout confirms signal direction.
  // Applied BEFORE rule 11 so the boost can help borderline signals pass the threshold.
  if (input.breakout && input.breakout.state !== "NONE") {
    const isAligned =
      (input.breakout.state === "BULLISH_BREAKOUT" && isBull) ||
      (input.breakout.state === "BEARISH_BREAKDOWN" && isBear);
    if (isAligned) {
      input.signal.confidence = Math.min(1.0, input.signal.confidence + 0.10);
      if (!input.signal.keyFactors.includes("breakout_aligned")) {
        input.signal.keyFactors.push("breakout_aligned");
      }
    }
  }

  // 11. Time-based confidence threshold
  // Morning (< 105 min) → 65%, Midday → 70%, Afternoon → 80%
  // Expiry week (Mon/Tue): floor raised to 75% minimum (both directions allowed).
  let confidenceThreshold: number;
  if (input.minutesSinceOpen < 105) {
    confidenceThreshold = CONFIDENCE_MORNING;
  } else if (input.minutesSinceOpen < 225) {
    confidenceThreshold = CONFIDENCE_MIDDAY;
  } else {
    confidenceThreshold = CONFIDENCE_AFTERNOON;
  }
  if (isExpiryWeekEnd) confidenceThreshold = Math.max(confidenceThreshold + 0.05, 0.75);
  // Respect env override only if it's stricter than the time-based floor
  confidenceThreshold = Math.max(confidenceThreshold, minConfidence);

  if (input.signal.confidence < confidenceThreshold) {
    const pct = (input.signal.confidence * 100).toFixed(1);
    return {
      action: "BLOCK",
      reason: `confidence_below_threshold:${pct}%`,
    };
  }

  // 12. RSI entry zone — don't chase exhausted momentum
  if (isBear && input.rsi < RSI_ENTRY_MIN) {
    return { action: "BLOCK", reason: `rsi_exhausted:${input.rsi.toFixed(1)}` };
  }
  if (isBull && input.rsi > RSI_ENTRY_MAX) {
    return { action: "BLOCK", reason: `rsi_exhausted:${input.rsi.toFixed(1)}` };
  }

  // 13. RSI slope too weak — momentum must confirm direction
  if (input.rsiSlope !== null && Math.abs(input.rsiSlope) < RSI_SLOPE_MIN) {
    return { action: "BLOCK", reason: `weak_momentum_slope:${input.rsiSlope.toFixed(2)}` };
  }

  // 14. Volume too low — low participation = unreliable signal
  if (input.volumeRatio < VOLUME_RATIO_MIN) {
    return { action: "BLOCK", reason: `low_volume:${input.volumeRatio.toFixed(2)}` };
  }

  // 15. PCR extremes — option chain already lopsided against the signal
  if (isBear && input.pcr > PCR_BEAR_MAX) {
    return { action: "BLOCK", reason: `pcr_extreme:${input.pcr.toFixed(2)}` };
  }
  if (isBull && input.pcr < PCR_BULL_MIN) {
    return { action: "BLOCK", reason: `pcr_extreme:${input.pcr.toFixed(2)}` };
  }

  // 16. LLM error flags
  if (input.signal.riskFlags.includes("parsing_error")) {
    return { action: "BLOCK", reason: "llm_parsing_error" };
  }
  if (input.signal.riskFlags.includes("llm_timeout")) {
    return { action: "BLOCK", reason: "llm_timeout" };
  }

  // 17. Duplicate strategy — exact same strategy already open
  const duplicate = input.openPositionsList.find(
    (p) => p.strategy === input.signal.strategy
  );
  if (duplicate) {
    return {
      action: "BLOCK",
      reason: `duplicate_strategy:${input.signal.strategy}`,
    };
  }

  // 18. Same direction — any open position already in the same directional camp
  const signalDirection =
    input.signal.strategy === "BEAR_CALL_SPREAD" ? "BEARISH" : "BULLISH";
  const sameDirectionPos = input.openPositionsList.find((p) => {
    const posDirection =
      p.strategy === "BEAR_CALL_SPREAD" ? "BEARISH" : "BULLISH";
    return posDirection === signalDirection;
  });
  if (sameDirectionPos) {
    return {
      action: "BLOCK",
      reason: `same_direction_open:${signalDirection}:${sameDirectionPos.strategy}`,
    };
  }

  // 19. Daily trade limit
  const maxDailyTrades = resolveNumberConfig("MAX_DAILY_TRADES", MAX_DAILY_TRADES);
  if (input.todayTradeCount >= maxDailyTrades) {
    return {
      action: "BLOCK",
      reason: `daily_limit:${input.todayTradeCount}:${maxDailyTrades}`,
    };
  }

  // 20. Max open positions
  if (input.openPositions >= maxPositions) {
    return {
      action: "BLOCK",
      reason: `max_open_positions_reached:${maxPositions}`,
    };
  }

  // 21. Daily loss limit
  if (input.dailyLossPct <= -maxDailyLossPct) {
    const pct = input.dailyLossPct.toFixed(2);
    return {
      action: "BLOCK",
      reason: `daily_loss_limit_hit:${pct}%`,
    };
  }

  // 22. Minimum credit — spread must yield enough premium to be worthwhile
  if (input.netCreditPts > 0 && input.netCreditPts < MIN_CREDIT_PTS) {
    return {
      action: "BLOCK",
      reason: `insufficient_credit:${input.netCreditPts.toFixed(1)}pts`,
    };
  }

  // ── S/R checks (23–26) — skipped when srContext not provided ─────────────
  if (input.srContext) {
    const sr = input.srContext;
    const atr = input.atr ?? 0;

    // 23. Compressed range — S/R band too tight to trade safely
    if (sr.rangeWidth !== null && sr.rangeWidth < SR_MIN_RANGE_PTS) {
      return {
        action: "BLOCK",
        reason: `compressed_range:${sr.rangeWidth.toFixed(0)}pts`,
      };
    }

    // 24. Near key S/R level — don't block, but dock confidence
    if (sr.isNearKeyLevel) {
      input.signal.confidence = Math.max(
        input.signal.confidence - SR_PROXIMITY_PENALTY,
        0.10
      );
      if (!input.signal.keyFactors.includes("near_key_sr_level")) {
        input.signal.keyFactors.push("near_key_sr_level");
      }
    }

    // 25. Bear call — resistance too close to current spot
    if (
      input.signal.strategy === "BEAR_CALL_SPREAD" &&
      sr.spotToResistance !== null &&
      atr > 0 &&
      sr.spotToResistance < atr * SR_ATR_BUFFER
    ) {
      return {
        action: "BLOCK",
        reason: `resistance_too_close:${sr.spotToResistance.toFixed(0)}pts`,
      };
    }

    // 26. Bull put — support too close to current spot
    if (
      input.signal.strategy === "BULL_PUT_SPREAD" &&
      sr.spotToSupport !== null &&
      atr > 0 &&
      sr.spotToSupport < atr * SR_ATR_BUFFER
    ) {
      return {
        action: "BLOCK",
        reason: `support_too_close:${sr.spotToSupport.toFixed(0)}pts`,
      };
    }
  }

  // ── Breakout conflict checks (27–28) — skipped when breakout not provided ──
  if (input.breakout && input.breakout.state !== "NONE") {
    // 27. BULLISH_BREAKOUT + BEAR_CALL_SPREAD — fighting the breakout direction
    if (input.breakout.state === "BULLISH_BREAKOUT" && isBear) {
      return {
        action: "BLOCK",
        reason: `breakout_conflict:BULLISH_BREAKOUT_vs_BEAR:${input.breakout.breachSize?.toFixed(0) ?? "?"}pts`,
      };
    }

    // 28. BEARISH_BREAKDOWN + BULL_PUT_SPREAD — fighting the breakdown direction
    if (input.breakout.state === "BEARISH_BREAKDOWN" && isBull) {
      return {
        action: "BLOCK",
        reason: `breakout_conflict:BEARISH_BREAKDOWN_vs_BULL:${input.breakout.breachSize?.toFixed(0) ?? "?"}pts`,
      };
    }
  }

  return { action: "SUGGEST" };
}
