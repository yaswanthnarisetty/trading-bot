/**
 * Traces P&L calculation for the first losing TIME_EXIT trade.
 * Shows rawPnL, slippage, finalPnL, and intermediate cappedPnL components.
 */
import { ALLOWED_ASSETS } from "../src/config/assets";
import {
  MAX_HOLD_BARS, EOD_CLOSE_HOUR, EOD_CLOSE_MINUTE,
  BASE_CAPITAL_FOR_LOTS, MAX_POSITIONS_DEFAULT, MAX_DAILY_TRADES,
  RISK_PER_TRADE_PCT, TARGET_PROFIT_PCT, STOP_LOSS_PCT,
  DIRECTIONAL_STOP_ATR_MULT, DIRECTIONAL_STOP_FALLBACK_PTS, SLIPPAGE_PTS,
} from "../src/config/constants";
import { computeAll } from "../src/services/IndicatorService";
import { selectStrategy, computeSpreadDetails } from "../src/services/StrategySelector";
import { fetchHistoricalOHLCV } from "../src/services/KiteService";

const API_KEY      = "1elbgsxv3vhjfre0";
const ACCESS_TOKEN = "dj77CwtR1rRjA2t1QFSXcbMV2HDfbKE6";
const asset        = "NIFTY" as const;
const lotSize      = ALLOWED_ASSETS[asset].lotSize;

interface SimPos {
  id: string; strategy: "BULL_PUT_SPREAD"|"BEAR_CALL_SPREAD";
  entryIndex: number; entryTimestamp: string; entrySpot: number;
  lots: number; lotSize: number;
  sellStrike: number; buyStrike: number;
  rawCredit: number; adjCredit: number;
  maxProfit: number; maxLoss: number;
  entryATR: number | null;
}

function cappedRaw(pos: SimPos, spot: number): number {
  const direction = pos.strategy === "BULL_PUT_SPREAD" ? 1 : -1;
  const move = (spot - pos.entrySpot) * direction;
  return move * 0.3 * pos.lotSize * pos.lots;
}

async function run() {
  const candles = await fetchHistoricalOHLCV(asset, {
    from: "2026-02-02T03:45:00.000Z",
    to:   "2026-03-09T10:00:00.000Z",
    interval: "5minute",
    apiKey: API_KEY, accessToken: ACCESS_TOKEN,
  });

  const assetConfig = ALLOWED_ASSETS[asset];
  let equity = 200_000;
  let openPositions: SimPos[] = [];
  const dailyTradeCounts = new Map<string, number>();
  let printed = false;

  for (let i = 59; i < candles.length; i++) {
    const candle = candles[i]!;
    const ch = candle.timestamp.getHours(), cm = candle.timestamp.getMinutes();
    const dayOfWeek = candle.timestamp.getDay();
    const isTuesdayCandle = dayOfWeek === 2;
    const isEOD = isTuesdayCandle ? ch >= 15 : ch > EOD_CLOSE_HOUR || (ch === EOD_CLOSE_HOUR && cm >= EOD_CLOSE_MINUTE);
    const isLastCandle = i === candles.length - 1;
    const isExpiryWeekEnd = dayOfWeek === 1 || dayOfWeek === 2;

    const stillOpen: SimPos[] = [];
    let exitedThisBar = false;

    for (const pos of openPositions) {
      const barsHeld = i - pos.entryIndex;
      const rawBeforeCap = cappedRaw(pos, candle.close);
      const rawPnL = Math.max(-pos.maxLoss, Math.min(pos.maxProfit, rawBeforeCap));
      const exitSlippageRupees = SLIPPAGE_PTS * 2 * pos.lotSize * pos.lots;
      const finalPnL = rawPnL - exitSlippageRupees;

      let shouldExit = false;
      let exitReason = "NONE";

      if (isEOD) { shouldExit = true; exitReason = "EOD_CLOSE"; }
      else if (barsHeld >= MAX_HOLD_BARS) { shouldExit = true; exitReason = "TIME_EXIT"; }
      else if (rawPnL >= pos.maxProfit * TARGET_PROFIT_PCT) { shouldExit = true; exitReason = "TARGET_HIT"; }
      else {
        const dsMult = DIRECTIONAL_STOP_ATR_MULT;
        const dsThreshold = pos.entryATR != null ? pos.entryATR * dsMult : DIRECTIONAL_STOP_FALLBACK_PTS;
        const spotMove = candle.close - pos.entrySpot;
        if ((pos.strategy === "BEAR_CALL_SPREAD" && spotMove > dsThreshold) ||
            (pos.strategy === "BULL_PUT_SPREAD"  && spotMove < -dsThreshold)) {
          shouldExit = true; exitReason = "STOP_HIT";
        }
        if (!shouldExit) {
          const stopPct = isExpiryWeekEnd ? 0.30 : STOP_LOSS_PCT;
          if (rawPnL <= -pos.maxLoss * stopPct) { shouldExit = true; exitReason = "STOP_HIT"; }
        }
      }
      if (!shouldExit && isLastCandle) { shouldExit = true; exitReason = "END_OF_DATA"; }

      if (shouldExit && exitReason === "TIME_EXIT" && finalPnL < 0 && !printed) {
        printed = true;
        const direction = pos.strategy === "BULL_PUT_SPREAD" ? 1 : -1;
        const move = candle.close - pos.entrySpot;

        // Implied option premium breakdown (delta model)
        // At entry: rawCredit was (rawCredit), after entry slippage (SLIPPAGE_PTS×2 pts) → adjCredit
        // The spread = (sellLeg entryPremium) - (buyLeg entryPremium) = rawCredit
        // We don't track individual legs, so show net values.
        const entrySlippagePts = SLIPPAGE_PTS * 2;
        const impliedExitCredit = pos.adjCredit - (direction * move * 0.3); // rough exit credit from delta

        console.log("\n=== LOSING TIME_EXIT TRADE TRACE ===");
        console.log(`Strategy:          ${pos.strategy}`);
        console.log(`Entry:             ${pos.entryTimestamp}  spot=${pos.entrySpot}`);
        console.log(`Exit:              ${candle.timestamp.toISOString()}  spot=${candle.close}`);
        console.log(`Bars held:         ${barsHeld} / ${MAX_HOLD_BARS}`);
        console.log(`Lots:              ${pos.lots}  lotSize=${pos.lotSize}`);
        console.log();
        console.log(`--- PREMIUMS (net credit spread, no individual leg breakdown in delta model) ---`);
        console.log(`rawCredit at entry (before entry slippage):   ${pos.rawCredit.toFixed(2)} pts`);
        console.log(`entrySlippage deducted:                      -${entrySlippagePts.toFixed(2)} pts  (SLIPPAGE_PTS×2)`);
        console.log(`adjCredit stored on position:                 ${pos.adjCredit.toFixed(2)} pts`);
        console.log(`adjCredit in ₹ (×lotSize×lots):              ₹${(pos.adjCredit * pos.lotSize * pos.lots).toFixed(0)}`);
        console.log();
        console.log(`--- EXIT P&L CALCULATION ---`);
        console.log(`spotMove:                    ${move.toFixed(1)} pts  (${candle.close} - ${pos.entrySpot})`);
        console.log(`direction factor:            ${direction}  (${pos.strategy})`);
        console.log(`sensitivity:                 0.3`);
        console.log(`rawBeforeCap (delta approx): ${rawBeforeCap.toFixed(0)} ₹`);
        console.log(`maxProfit cap:               ₹${pos.maxProfit.toFixed(0)}`);
        console.log(`maxLoss floor:              -₹${pos.maxLoss.toFixed(0)}`);
        console.log(`rawPnL (after capping):      ₹${rawPnL.toFixed(0)}   ← used for trigger decisions`);
        console.log();
        console.log(`--- SLIPPAGE ---`);
        console.log(`exitSlippage = ${SLIPPAGE_PTS} × 2 × ${pos.lotSize} × ${pos.lots} = ₹${exitSlippageRupees.toFixed(0)}`);
        console.log(`entrySlippage = ${entrySlippagePts} pts × ${pos.lotSize} × ${pos.lots} = ₹${(entrySlippagePts * pos.lotSize * pos.lots).toFixed(0)}`);
        console.log(`totalSlippage (entry+exit):  ₹${(entrySlippagePts * pos.lotSize * pos.lots + exitSlippageRupees).toFixed(0)}`);
        console.log();
        console.log(`--- FINAL ---`);
        console.log(`finalPnL = rawPnL - exitSlippage = ₹${rawPnL.toFixed(0)} - ₹${exitSlippageRupees.toFixed(0)} = ₹${finalPnL.toFixed(0)}`);
        console.log(`maxProfit (adjCredit × lot × lots): ₹${pos.maxProfit.toFixed(0)}`);
        console.log(`maxLoss:                            ₹${pos.maxLoss.toFixed(0)}`);
      }

      if (shouldExit) { equity += finalPnL; exitedThisBar = true; }
      else { stillOpen.push(pos); }
    }

    openPositions = stillOpen;
    if (exitedThisBar) continue;

    const entryHour = candle.timestamp.getHours(), entryMin = candle.timestamp.getMinutes();
    if (entryHour > 15 || (entryHour === 15 && entryMin >= 0)) continue;

    const history = candles.slice(0, i + 1);
    const indicators = computeAll(history);
    const direction = indicators.emaAlignment === "bullish" ? "BULLISH" : indicators.emaAlignment === "bearish" ? "BEARISH" : "NEUTRAL";
    const dte = (function(ts: Date) {
      const d = ts.getDay(); let days = (assetConfig.expiryDay - d + 7) % 7;
      if (days === 0 && (ts.getHours() > 15 || (ts.getHours() === 15 && ts.getMinutes() >= 30))) days = 7;
      return days;
    })(candle.timestamp);
    const selection = selectStrategy(direction, 50, dte, indicators.regime);
    if (selection.strategy === "HOLD") continue;

    const signalTs = candle.timestamp.toISOString();
    const candleDate = signalTs.slice(0, 10);
    const todayCount = dailyTradeCounts.get(candleDate) ?? 0;

    if (openPositions.some(p => p.strategy === selection.strategy)) continue;
    if (openPositions.some(p => (p.strategy === "BEAR_CALL_SPREAD" ? "BEARISH" : "BULLISH") === (selection.strategy === "BEAR_CALL_SPREAD" ? "BEARISH" : "BULLISH"))) continue;
    if (todayCount >= MAX_DAILY_TRADES) continue;
    if (openPositions.length >= MAX_POSITIONS_DEFAULT) continue;

    const spread = computeSpreadDetails(candle.close, { delta: 0.3, gamma: 0, theta: -0.02, vega: 0.1 }, asset, selection.strategy);

    const entrySlippagePts = SLIPPAGE_PTS * 2;
    const adjCredit  = Math.max(0, spread.credit - entrySlippagePts);
    const adjMaxLoss = spread.maxLoss + entrySlippagePts;
    const capitalScale = Math.max(1, equity / BASE_CAPITAL_FOR_LOTS);
    const effectiveRiskPct = Math.min(10, RISK_PER_TRADE_PCT * capitalScale);
    const maxRiskAmount = (equity * effectiveRiskPct) / 100;
    const maxLossPerLot = adjMaxLoss * lotSize;
    const lots = maxLossPerLot <= 0 ? 1 : Math.max(1, Math.floor(maxRiskAmount / maxLossPerLot));

    openPositions.push({
      id: `bt-${asset}-${i}`,
      strategy: selection.strategy,
      entryIndex: i, entryTimestamp: signalTs, entrySpot: candle.close,
      lots, lotSize,
      sellStrike: spread.sellStrike, buyStrike: spread.buyStrike,
      rawCredit: spread.credit, adjCredit,
      maxProfit: adjCredit  * lotSize * lots,
      maxLoss:   adjMaxLoss * lotSize * lots,
      entryATR: indicators.atr ?? null,
    });
    dailyTradeCounts.set(candleDate, todayCount + 1);
  }
}

run().catch(console.error);
