import { ALLOWED_ASSETS, type AssetKey } from "../config/assets";
import { formatISTTime } from "../utils/marketHours";
import {
  type OHLCVData,
  type OHLCV,
  type OptionChainData,
  type OptionChainStrike,
  type MarketData,
  type NewsSentiment,
} from "../types/trading";
import { logger } from "../utils/logger";

interface AssetState {
  lastPrice: number;
  trendBias: number;
  lastVolume: number;
}

const assetState: Map<AssetKey, AssetState> = new Map();

const MOCK_HEADLINES: string[] = [
  "NIFTY extends winning streak on strong banking stocks",
  "BANKNIFTY trims gains as PSU banks see profit booking",
  "FINNIFTY holds steady amid mixed global cues",
  "Volatility picks up ahead of weekly expiry for index options",
  "IT and financials lead intraday recovery on Dalal Street",
  "Global risk-on sentiment lifts Indian equities to new highs",
];

let headlineIndex = 0;

/**
 * Seeds the mock data state for a given asset using its configured base price.
 * This function initializes the random walk parameters used for subsequent ticks.
 *
 * @param asset - The allowed asset key to initialize.
 */
export function init(asset: AssetKey): void {
  const config = ALLOWED_ASSETS[asset];
  const initialPrice = config.basePrice;

  assetState.set(asset, {
    lastPrice: initialPrice,
    trendBias: Math.random() * 2 - 1, // random bullish/bearish bias
    lastVolume: config.lotSize * 100,
  });

  logger.info("MockDataService initialized", {
    asset,
    basePrice: initialPrice,
  });
}

/**
 * Generates a single 1-minute OHLCV candle from the current random walk state.
 * Volatility and volume are modulated by time-of-day to mimic real intraday behavior.
 *
 * @param asset - The asset whose price series is being simulated.
 * @param prev - The previous OHLCV candle used as the starting point.
 * @returns A new OHLCV candle advancing the series by one minute.
 */
function generateNextCandle(asset: AssetKey, prev: OHLCV): OHLCV {
  const state = assetState.get(asset);
  const config = ALLOWED_ASSETS[asset];

  if (!state) {
    init(asset);
  }

  const effectiveState = state ?? assetState.get(asset as AssetKey)!;

  const timestamp = new Date(prev.timestamp.getTime() + 60_000);
  const hours = timestamp.getHours();
  const minutes = timestamp.getMinutes();

  // Higher volatility at open and close
  const isOpenWindow =
    hours === 9 && minutes >= 15 && minutes <= 45;
  const isCloseWindow =
    (hours === 14 && minutes >= 45) || (hours === 15 && minutes <= 30);

  const baseVol = config.basePrice * 0.001;
  const volFactor = isOpenWindow || isCloseWindow ? 3 : 1;
  const drift = effectiveState.trendBias * baseVol * 0.3;
  const randomShock = (Math.random() - 0.5) * baseVol * volFactor;

  const open = prev.close;
  const close = Math.max(1, open + drift + randomShock);
  const high = Math.max(open, close) + Math.random() * baseVol * volFactor;
  const low = Math.min(open, close) - Math.random() * baseVol * volFactor;

  // Volume spikes at open and close
  const volumeBase = effectiveState.lastVolume || config.lotSize * 100;
  const volumeFactor = isOpenWindow || isCloseWindow ? 2.5 : 1;
  const volume =
    volumeBase * volumeFactor * (0.8 + Math.random() * 0.4);

  effectiveState.lastPrice = close;
  effectiveState.lastVolume = volume;

  return {
    timestamp,
    open,
    high,
    low,
    close,
    volume,
  };
}

/**
 * Generates a sequence of 20 one-minute OHLCV candles for mock trading.
 * This provides enough recent history for indicator computation at each tick.
 *
 * @param asset - The asset to generate data for.
 * @returns An array of 20 OHLCV candles representing the recent price path.
 */
export function generateOHLCV(asset: AssetKey): OHLCVData {
  const config = ALLOWED_ASSETS[asset];
  const state = assetState.get(asset) ?? {
    lastPrice: config.basePrice,
    trendBias: Math.random() * 2 - 1,
    lastVolume: config.lotSize * 100,
  };
  assetState.set(asset, state);

  const candles: OHLCVData = [];
  const now = new Date();
  let lastCandle: OHLCV = {
    timestamp: new Date(now.getTime() - 20 * 60_000),
    open: state.lastPrice,
    high: state.lastPrice,
    low: state.lastPrice,
    close: state.lastPrice,
    volume: state.lastVolume,
  };

  for (let i = 0; i < 20; i += 1) {
    const next = generateNextCandle(asset, lastCandle);
    candles.push(next);
    lastCandle = next;
  }

  state.lastPrice = lastCandle.close;
  state.lastVolume = lastCandle.volume;

  return candles;
}

/**
 * Generates a mock last traded price (LTP) by applying a small random shock.
 * This keeps LTP consistent with the underlying OHLCV random walk.
 *
 * @param asset - The asset to generate an LTP for.
 * @returns A single price value for use in position monitoring and Greeks.
 */
export function generateLTP(asset: AssetKey): number {
  const config = ALLOWED_ASSETS[asset];
  const state = assetState.get(asset) ?? {
    lastPrice: config.basePrice,
    trendBias: Math.random() * 2 - 1,
    lastVolume: config.lotSize * 100,
  };
  assetState.set(asset, state);

  const shock = (Math.random() - 0.5) * config.basePrice * 0.001;
  state.lastPrice = Math.max(1, state.lastPrice + shock);
  return state.lastPrice;
}

/**
 * Builds a mock option chain around the current spot price.
 * The chain includes ATM plus four strikes above and below with realistic IV skew.
 *
 * @param asset - Asset whose option chain is being simulated.
 * @param spot - Current spot price used to center the strike ladder.
 * @returns A synthetic option chain suitable for Greeks and IV analysis.
 */
export function generateOptionChain(
  asset: AssetKey,
  spot: number
): OptionChainData {
  const config = ALLOWED_ASSETS[asset];
  const step =
    asset === "BANKNIFTY" ? 100 : asset === "FINNIFTY" ? 50 : 50;

  const atmStrike = Math.round(spot / step) * step;
  const strikes: OptionChainStrike[] = [];

  for (let i = -4; i <= 4; i += 1) {
    const strike = atmStrike + i * step;
    const moneyness = (strike - spot) / spot;

    const baseIV =
      asset === "BANKNIFTY"
        ? 0.18
        : asset === "FINNIFTY"
        ? 0.17
        : 0.16;

    // Realistic skew: OTM options slightly higher IV
    const iv = baseIV + Math.abs(moneyness) * 0.1;

    const basePremium = Math.max(5, spot * iv * 0.25);
    const distanceFactor = Math.exp(-Math.abs(moneyness) * 4);

    const ceLtp =
      i >= 0
        ? basePremium * distanceFactor
        : basePremium * distanceFactor * 0.7;
    const peLtp =
      i <= 0
        ? basePremium * distanceFactor
        : basePremium * distanceFactor * 0.7;

    const baseOi = config.lotSize * 5000;
    const oi =
      baseOi * (1 + (Math.random() - 0.5) * 0.4) * (1 - Math.abs(moneyness));

    strikes.push({
      strike,
      ce: {
        oi: Math.max(0, Math.round(oi)),
        iv,
        bid: ceLtp * 0.99,
        ask: ceLtp * 1.01,
        ltp: ceLtp,
      },
      pe: {
        oi: Math.max(0, Math.round(oi)),
        iv,
        bid: peLtp * 0.99,
        ask: peLtp * 1.01,
        ltp: peLtp,
      },
    });
  }

  const totalPutOi = strikes.reduce((sum, s) => sum + s.pe.oi, 0);
  const totalCallOi = strikes.reduce((sum, s) => sum + s.ce.oi, 0);
  const pcr =
    totalCallOi === 0 ? 1 : totalPutOi / totalCallOi;

  return {
    underlying: asset,
    expiry: new Date(),
    spot,
    strikes,
    pcr,
  };
}

/**
 * Produces a rotating mock news sentiment snapshot for an asset.
 * This is used when real NewsAPI access is unavailable or disabled.
 *
 * @returns A NewsSentiment object with human-readable headline and score.
 */
export function generateNewsSentiment(): NewsSentiment {
  const headline = MOCK_HEADLINES[headlineIndex % MOCK_HEADLINES.length];
  headlineIndex += 1;

  const lower = headline.toLowerCase();
  let score = 0;

  if (lower.includes("rally") || lower.includes("high") || lower.includes("gain") || lower.includes("strong")) {
    score = 0.6;
  } else if (lower.includes("fall") || lower.includes("crash") || lower.includes("loss") || lower.includes("weak")) {
    score = -0.6;
  } else {
    score = 0;
  }

  const sentiment: NewsSentiment["sentiment"] =
    score > 0.1 ? "bullish" : score < -0.1 ? "bearish" : "neutral";

  logger.debug("Mock news sentiment generated", {
    headline,
    score,
    sentiment,
    time: formatISTTime(new Date()),
  });

  return {
    sentiment,
    score,
    headline,
  };
}

/**
 * Convenience helper to assemble full mock market data for a tick.
 * This allows other services to treat mock and live data uniformly via MarketData.
 *
 * @param asset - The asset for which to generate market data.
 * @returns A MarketData bundle including OHLCV, LTP, volume, and dataMode.
 */
export function generateMarketData(asset: AssetKey): MarketData {
  const ohlcv = generateOHLCV(asset);
  const ltp = ohlcv[ohlcv.length - 1]?.close ?? ALLOWED_ASSETS[asset].basePrice;
  const volume = ohlcv.reduce((sum, c) => sum + c.volume, 0);

  return {
    asset,
    ohlcv,
    ltp,
    volume,
    dataMode: "MOCK",
  };
}

