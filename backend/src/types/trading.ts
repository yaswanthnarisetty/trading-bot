import type { AssetKey } from "../config/assets";
import type {
  IndicatorSnapshot,
  GreeksSnapshot,
} from "@trading-bot/shared";

/**
 * Option types supported in MVP-1.
 * These map directly to NSE option contract types.
 */
export type OptionType = "CALL" | "PUT";

/**
 * Option action types for individual legs.
 * This is used in spread construction and PnL calculations.
 */
export type OptionAction = "BUY" | "SELL";

/**
 * Single OHLCV candle representation for 1-minute data.
 * This structure backs all indicator computations and mock data.
 */
export interface OHLCV {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Collection of OHLCV candles used as the base time series input.
 * All indicator services operate on this array shape.
 */
export type OHLCVData = OHLCV[];

/**
 * Quote snapshot for a single option contract at a given strike.
 * Used both in mock option chains and live Kite data normalization.
 */
export interface OptionQuote {
  oi: number;
  iv: number;
  bid: number;
  ask: number;
  ltp: number;
}

/**
 * Combined call/put view for a single strike in the option chain.
 * This simplifies PCR, max pain, and skew computations.
 */
export interface OptionChainStrike {
  strike: number;
  ce: OptionQuote;
  pe: OptionQuote;
}

/**
 * Normalized option chain for a single underlying and expiry.
 * Backend services use this for Greeks and IV context only.
 */
export interface OptionChainData {
  underlying: AssetKey;
  expiry: Date;
  spot: number;
  strikes: OptionChainStrike[];
  pcr: number;
}

/**
 * Aggregated market data bundle for a tick.
 * This combines OHLCV time series, latest price, and total volume.
 */
export interface MarketData {
  asset: AssetKey;
  ohlcv: OHLCVData;
  ltp: number;
  volume: number;
  dataMode: "LIVE" | "MOCK";
}

/**
 * Market regime classification used for strategy selection.
 * Must stay in sync with IndicatorSnapshot.regime values.
 */
export type Regime = IndicatorSnapshot["regime"];

/**
 * Simple Greeks container used inside the GreeksEngine.
 * The full GreeksSnapshot adds richer IV context on top of this core.
 */
export interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

/**
 * Sentiment snapshot used for LLM context and risk assessment.
 * This is computed deterministically from news headlines or mock data.
 */
export interface NewsSentiment {
  sentiment: "bullish" | "bearish" | "neutral";
  score: number;
  headline: string;
}

/**
 * Spread configuration details for a single credit spread trade.
 * These values feed position sizing and paper trade calculations.
 */
export interface SpreadDetails {
  strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
  sellStrike: number;
  buyStrike: number;
  credit: number;
  maxLoss: number;
  breakeven: number;
  riskReward: number;
}

/**
 * High-level portfolio snapshot for a session.
 * This is used for dashboards, LLM context, and risk checks.
 */
export interface PortfolioSummary {
  openPositions: number;
  netDelta: number;
  netTheta: number;
  totalCapitalAtRisk: number;
  dailyPnL: number;
}

export type { GreeksSnapshot };

