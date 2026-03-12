/**
 * System-wide constants for trading logic.
 * These are NOT env vars — they are fixed rules of the system.
 * Changing these requires understanding their downstream impact.
 */

// Risk guard thresholds
export const MIN_CONFIDENCE_DEFAULT = 0.65;
export const MAX_POSITIONS_DEFAULT = 3;
export const MAX_DAILY_LOSS_PCT_DEFAULT = 2;
export const RISK_PER_TRADE_PCT = 4; // max 4% of capital per trade — more lots as capital grows
export const BASE_CAPITAL_FOR_LOTS = 200_000; // backtest & paper lots scale with capital/base

// LLM settings — low temperature for deterministic signals
export const LLM_TEMPERATURE = 0.2;
export const LLM_MAX_TOKENS = 600;
export const LLM_TIMEOUT_MS = 15000; // 15 seconds — abort if slower
export const LLM_MODEL = "gpt-4o-mini";

// Signal loop timing
export const TICK_INTERVAL_MS = 300000; // 5 minutes — matches live candle granularity
export const POSITION_MONITOR_INTERVAL_MS = 5000; // 5 seconds — fast exit detection for SL/target/EOD
export const MAX_HOLDING_MINUTES = 60; // time exit after 60 min (12 × 5min candles)

// Options strategy rules
export const MIN_DTE_FOR_BUYING = 3; // never buy options with < 3 DTE
export const HIGH_IV_RANK_THRESHOLD = 70; // IV rank above this = expensive premium
export const MAX_DAILY_TRADES = 3; // max new positions per calendar day (configurable via MAX_DAILY_TRADES env)

// Exit thresholds — used by BOTH live monitor and backtest. Change here to affect both.
export const TARGET_PROFIT_PCT = 0.5;  // take profit at 50% of max credit received
export const STOP_LOSS_PCT = 0.5;      // cut loss at 50% of max loss (not full loss)
export const MAX_HOLD_BARS = 12;       // time exit after 12 × 5min bars = 60 minutes

// Directional stop — exits when underlying moves this many ATR units against the spread.
// threshold = entryATR × DIRECTIONAL_STOP_ATR_MULT
// If entryATR is unavailable (warmup), DIRECTIONAL_STOP_FALLBACK_PTS is used instead.
// Backtest Feb–Mar 2026: ATR×1.5=₹632, ATR×3.0=₹5210 (best), none=₹3483
// ATR×3.0 ≈ 162pts for NIFTY — only triggers on catastrophic moves, not normal volatility.
export const DIRECTIONAL_STOP_ATR_MULT = 3.0;
export const DIRECTIONAL_STOP_FALLBACK_PTS = 160;

// Market hours (IST)
export const MARKET_OPEN_HOUR = 9;
export const MARKET_OPEN_MINUTE = 15;
export const MARKET_CLOSE_HOUR = 15;
export const MARKET_CLOSE_MINUTE = 30;
export const NO_NEW_POSITIONS_HOUR = 15;
export const NO_NEW_POSITIONS_MINUTE = 20;
export const EOD_CLOSE_HOUR = 15;
export const EOD_CLOSE_MINUTE = 20; // force-close window: 15:20–15:30 IST

// Confidence floor and caps — prevents misleading 0% display on dashboard
export const CONFIDENCE_FLOOR = 0.10;         // never show below 10%
export const CONFIDENCE_CAP_MORNING = 0.50;   // first 60 min — indicators not warmed up
export const CONFIDENCE_CAP_DTE1 = 0.60;      // DTE=1 — high gamma risk
export const CONFIDENCE_CAP_DTE0 = 0.40;      // DTE=0 — expiry day, extreme risk

// Risk-free rate for Black-Scholes (India RBI repo rate approx)
export const RISK_FREE_RATE = 0.065; // 6.5% as decimal

// Slippage model for backtest — bid-ask spread cost per leg (conservative estimate).
// Applied at entry AND exit: total round-trip cost = SLIPPAGE_PTS × 4 per lot in points.
// 3 pts ≈ realistic bid-ask for liquid NIFTY/BANKNIFTY options on NSE.
export const SLIPPAGE_PTS = 1.5;

// Entry quality filters — used by RiskGuardService and BacktestService
export const MIN_CREDIT_PTS = 25;          // minimum net credit to accept a spread entry
export const RSI_ENTRY_MIN = 30;           // bear signals blocked if RSI < this (oversold = bad for bears)
export const RSI_ENTRY_MAX = 70;           // bull signals blocked if RSI > this (overbought = bad for bulls)
export const RSI_SLOPE_BARS = 3;           // RSI slope lookback in bars
export const RSI_SLOPE_MIN = 1;            // minimum |rsiSlope| to confirm momentum
export const VOLUME_RATIO_MIN = 0.0;       // minimum volume vs recent average (0 = disabled — model too rough)
export const SKIP_OPEN_MINUTES = 15;       // skip first 15 min of session (9:15–9:30 IST)
export const ATR_MAX_ENTRY = 70;           // block entry if ATR exceeds this (too volatile)

// VIX thresholds — reserved for future filter when VIX feed is available
export const VIX_MIN = 10;
export const VIX_MAX = 20;

// PCR extremes — block when option chain is too lopsided for the signal direction
export const PCR_BEAR_MAX = 1.3;  // bear signal blocked if pcr > this (puts already dominant)
export const PCR_BULL_MIN = 0.7;  // bull signal blocked if pcr < this (calls already dominant)

// Time-based confidence thresholds — replace flat 65% with time-aware gates
export const CONFIDENCE_MORNING   = 0.65;  // 9:30–11:00 IST (first 105 min)
export const CONFIDENCE_MIDDAY    = 0.70;  // 11:00–13:00 IST (next 120 min)
export const CONFIDENCE_AFTERNOON = 0.80;  // 13:00–15:00 IST (final session)

// Margin estimation — used when Kite margin API is unavailable
// Real SEBI SPAN margin for a credit spread ≈ spreadWidth × lotSize × lots × multiplier
// For 100pt NIFTY spread: 100 × 50 × 1 × 10 = ₹50,000 (close to live SPAN values)
export const MARGIN_ESTIMATE_MULTIPLIER = 10;

// Hard cap on margin as a fraction of available capital
// Positions are blocked (not just warned) when requiredMargin > capital × this
export const MAX_MARGIN_UTILIZATION = 0.80;

// Heartbeat interval for WebSocket keep-alive
export const WS_HEARTBEAT_INTERVAL_MS = 20000; // 20 seconds

// Support & Resistance (S/R) filters — used by RiskGuardService and StrategySelector
export const SR_ATR_BUFFER = 1.0;          // ATR multiplier: block if spot < ATR×buffer from S/R
export const SR_PROXIMITY_PENALTY = 0.10;  // reduce confidence by this when near a key S/R level
export const SR_MIN_RANGE_PTS = 50;       // minimum S/R range in pts to allow entry
export const PDH_PDL_BUFFER = 50;          // pts buffer around Previous Day High/Low (informational)
export const MAX_OI_BUFFER = 75;          // pts buffer beyond max OI strike (informational)

// Breakout detection — used by indicators.ts detectBreakout()
// A candle qualifies as a breakout only if:
//   1. Close breaches a key S/R level by >= ATR × BREAKOUT_ATR_MULTIPLIER pts
//   2. Candle volume >= 20-bar average volume × BREAKOUT_VOLUME_RATIO
//   3. The breach happened within the last BREAKOUT_EXPIRY_CANDLES bars
export const BREAKOUT_ATR_MULTIPLIER = 0.3; // minimum breach size as fraction of ATR
export const BREAKOUT_VOLUME_RATIO = 1.3;   // volume must be 30% above 20-bar avg to confirm
export const BREAKOUT_EXPIRY_CANDLES = 6;   // breakout state expires after 6 × 5min bars (30 min)
