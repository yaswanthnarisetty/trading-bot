import type { CryptoSignal } from "@trading-bot/shared";
import type { OHLCV } from "../types/trading";
import { getDeltaCandles } from "./DeltaService";
import type { CryptoAssetKey } from "../config/assets";
import {
  CRYPTO_EMA_FAST,
  CRYPTO_EMA_MID,
  CRYPTO_EMA_SLOW,
  CRYPTO_RSI_PERIOD,
  CRYPTO_ATR_PERIOD,
  CRYPTO_VOLUME_RATIO_MIN,
  CRYPTO_SIGNAL_LOOKBACK_BARS,
  CRYPTO_MIN_CONFIDENCE,
} from "../config/constants";
import { logger } from "../utils/logger";

// ─── Indicator Calculations ──────────────────────────────────────────────────
// These are inlined rather than importing from IndicatorService.ts (options-specific)
// to keep the crypto engine fully isolated. The math is identical.

/**
 * Computes Exponential Moving Average over close prices.
 * @param prices - Close prices in chronological order
 * @param period - EMA period
 */
function computeEMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i]! * k + ema * (1 - k);
  }
  return parseFloat(ema.toFixed(2));
}

/**
 * Computes RSI (Wilder smoothing) from candle close prices.
 * @param prices - Close prices in chronological order
 * @param period - RSI period (default 14)
 */
function computeRSI(prices: number[], period: number): number {
  if (prices.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i]! - prices[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i]! - prices[i - 1]!;
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

/**
 * Computes Average True Range (Wilder smoothing).
 * @param candles - OHLCV candles in chronological order
 * @param period  - ATR period (default 14)
 */
function computeATR(candles: OHLCV[], period: number): number {
  if (candles.length < period + 1) return 0;

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low  - prev.close)
    );
    trs.push(tr);
  }

  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
  }
  return parseFloat(atr.toFixed(2));
}

/**
 * Computes the ratio of the latest candle volume to the 20-bar average.
 */
function computeVolumeRatio(candles: OHLCV[]): number {
  if (candles.length < 21) return 1;
  const recent = candles.slice(-21, -1);
  const avg = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  const latest = candles[candles.length - 1]?.volume ?? 0;
  return avg > 0 ? parseFloat((latest / avg).toFixed(2)) : 1;
}

// ─── Signal Evaluation ───────────────────────────────────────────────────────

/**
 * Evaluates a directional signal for a BTC perpetual using EMA alignment,
 * RSI momentum filtering, and volume confirmation.
 *
 * Long conditions:
 *   EMA9 > EMA21 > EMA50 (bullish alignment)
 *   RSI between 45–65 (mid-momentum, not overbought)
 *   Volume ratio >= CRYPTO_VOLUME_RATIO_MIN
 *
 * Short conditions:
 *   EMA9 < EMA21 < EMA50 (bearish alignment)
 *   RSI between 35–55 (mid-momentum, not oversold)
 *   Volume ratio >= CRYPTO_VOLUME_RATIO_MIN
 *
 * @param asset - Crypto asset to evaluate
 * @returns CryptoSignal with side, confidence, and raw indicator values
 */
export async function evaluateCryptoSignal(
  asset: CryptoAssetKey
): Promise<CryptoSignal> {
  const candles = await getDeltaCandles(asset, 60, CRYPTO_SIGNAL_LOOKBACK_BARS);

  const closes = candles.map((c) => c.close);

  const ema9  = computeEMA(closes, CRYPTO_EMA_FAST);
  const ema21 = computeEMA(closes, CRYPTO_EMA_MID);
  const ema50 = computeEMA(closes, CRYPTO_EMA_SLOW);
  const rsi   = computeRSI(closes, CRYPTO_RSI_PERIOD);
  const atr   = computeATR(candles, CRYPTO_ATR_PERIOD);
  const volumeRatio = computeVolumeRatio(candles);
  const timestamp   = new Date().toISOString();

  // ── Alignment flags ──────────────────────────────────────────────────────
  const bullishAlignment = ema9 > ema21 && ema21 > ema50;
  const bearishAlignment = ema9 < ema21 && ema21 < ema50;
  const volumeOk = volumeRatio >= CRYPTO_VOLUME_RATIO_MIN;

  const longRsiOk  = rsi >= 45 && rsi <= 65;
  const shortRsiOk = rsi >= 35 && rsi <= 55;

  let side: CryptoSignal["side"] = "HOLD";
  let confidence = 0;
  let reason = "No alignment";

  if (bullishAlignment && longRsiOk && volumeOk) {
    side      = "LONG";
    // Confidence: base 0.60 + up to 0.20 from EMA separation + up to 0.20 from volume
    const emaSep = Math.min((ema9 - ema50) / ema50, 0.02) / 0.02; // normalised 0–1
    const volBoost = Math.min((volumeRatio - 1.2) / 0.8, 1);       // beyond min, up to 2.0×
    confidence = parseFloat(
      Math.min(0.60 + emaSep * 0.20 + volBoost * 0.20, 1).toFixed(2)
    );
    reason = `Bullish EMA alignment (${ema9}>${ema21}>${ema50}), RSI=${rsi}, volRatio=${volumeRatio}`;
  } else if (bearishAlignment && shortRsiOk && volumeOk) {
    side      = "SHORT";
    const emaSep = Math.min((ema50 - ema9) / ema50, 0.02) / 0.02;
    const volBoost = Math.min((volumeRatio - 1.2) / 0.8, 1);
    confidence = parseFloat(
      Math.min(0.60 + emaSep * 0.20 + volBoost * 0.20, 1).toFixed(2)
    );
    reason = `Bearish EMA alignment (${ema9}<${ema21}<${ema50}), RSI=${rsi}, volRatio=${volumeRatio}`;
  } else {
    const reasons: string[] = [];
    if (!bullishAlignment && !bearishAlignment) reasons.push("no EMA alignment");
    if (!longRsiOk && !shortRsiOk) reasons.push(`RSI=${rsi} in neutral zone`);
    if (!volumeOk) reasons.push(`volume ratio=${volumeRatio} < ${CRYPTO_VOLUME_RATIO_MIN}`);
    reason = reasons.join(", ");
  }

  const signal: CryptoSignal = {
    asset,
    side,
    confidence,
    rsi,
    ema9,
    ema21,
    ema50,
    atr,
    volumeRatio,
    timestamp,
    reason,
  };

  logger.debug("Crypto signal evaluated", {
    asset,
    side,
    confidence,
    rsi,
    ema9,
    ema21,
    ema50,
  });

  return signal;
}

/**
 * Returns true if the signal meets the minimum confidence threshold to open a position.
 */
export function isActionableSignal(signal: CryptoSignal): boolean {
  return signal.side !== "HOLD" && signal.confidence >= CRYPTO_MIN_CONFIDENCE;
}
