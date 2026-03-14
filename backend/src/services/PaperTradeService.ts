import { v4 as uuidv4 } from "uuid";
import type { PrimarySignal, OptionsPosition } from "@trading-bot/shared";
import { OptionsPositionModel } from "../models/OptionsPosition";
import { ALLOWED_ASSETS, type AssetKey } from "../config/assets";
import { RISK_PER_TRADE_PCT, MAX_MARGIN_UTILIZATION } from "../config/constants";
import type { SpreadDetails } from "../types/trading";
import { buildNFOOptionSymbol, fetchOptionLTP, getSpreadMargin, isMock } from "./KiteService";
import { getWeeklyExpiryDate } from "../utils/marketHours";
import { logger } from "../utils/logger";

/**
 * Opens a new paper options position based on a validated signal and spread configuration.
 * Position sizing follows the fixed 4% risk rule — lots scale with capital.
 *
 * @param signal - The primary trading signal driving this position.
 * @param spreadDetails - Deterministic spread configuration (strikes, credit, max loss).
 * @param sessionId - Identifier for the monitoring session.
 * @param asset - Asset key for the underlying index.
 * @param paperCapital - Current paper capital for the session.
 * @param entrySpot - Actual underlying LTP at the moment of entry.
 * @param entryDTE - Actual days-to-expiry at entry from the expiry context.
 * @param dataMode - Whether the session is using live or mock data.
 * @returns Promise resolving to the saved OptionsPosition document.
 */
export async function openPosition(
  signal: PrimarySignal,
  spreadDetails: SpreadDetails,
  sessionId: string,
  asset: AssetKey,
  paperCapital: number,
  entrySpot: number,
  entryDTE: number,
  dataMode: "LIVE" | "MOCK",
  entryATR: number | null = null
): Promise<OptionsPosition> {
  const assetConfig = ALLOWED_ASSETS[asset];
  const lotSize = assetConfig.lotSize;

  // ── Step 1: Determine option type for each leg ──────────────────────────────
  // BULL_PUT_SPREAD sells/buys PUTs; BEAR_CALL_SPREAD sells/buys CALLs.
  // legType  → shared schema ("CALL" | "PUT") used on the position document
  // kiteType → Kite symbol suffix ("CE" | "PE") used only for LTP fetch
  const legType:  "CALL" | "PUT" = spreadDetails.strategy === "BULL_PUT_SPREAD" ? "PUT" : "CALL";
  const kiteType: "CE"   | "PE"  = spreadDetails.strategy === "BULL_PUT_SPREAD" ? "PE"  : "CE";

  // ── Step 2: Attempt to fetch real LTPs from Kite in LIVE mode ───────────────
  // In MOCK mode or on any failure, fall back to the Black-Scholes estimate.
  // Estimated fallback: sellLegPremium = net credit, buyLegPremium = 0.
  // This gives the correct net credit for P&L, but per-leg display is approximate.
  let sellLegPremium = spreadDetails.credit;
  let buyLegPremium  = 0;
  let premiumSource: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" = "BLACK_SCHOLES";

  // Hoisted so it can be reused by both the LTP fetch and margin check below.
  const expiryDate = getWeeklyExpiryDate(asset);

  if (!isMock()) {
    const sellSymbol  = buildNFOOptionSymbol(asset, expiryDate, spreadDetails.sellStrike, kiteType);
    const buySymbol   = buildNFOOptionSymbol(asset, expiryDate, spreadDetails.buyStrike,  kiteType);

    const [sellLTP, buyLTP] = await Promise.all([
      fetchOptionLTP(sellSymbol),
      fetchOptionLTP(buySymbol),
    ]);

    if (sellLTP !== null && buyLTP !== null && sellLTP > buyLTP) {
      sellLegPremium = sellLTP;
      buyLegPremium  = buyLTP;
      premiumSource  = "KITE_LTP";
      logger.info("✅ Real option premiums fetched from Kite", {
        sellSymbol, sellLTP,
        buySymbol,  buyLTP,
        netCredit:        parseFloat((sellLTP - buyLTP).toFixed(2)),
        netCreditRupees:  Math.round((sellLTP - buyLTP) * lotSize),
        asset,
      });
    } else {
      // DTE=0: Black-Scholes is completely unreliable — delta model breaks down at
      // expiry (all premium is intrinsic, no time value, gamma is infinite at ATM).
      // Block the trade rather than record a 6x-wrong entry premium.
      if (entryDTE === 0) {
        logger.error(
          `❌ Blocking DTE=0 trade — LTP unavailable for ${sellSymbol} / ${buySymbol}. ` +
          `Black-Scholes fallback is unreliable at expiry (intrinsic only, no time value).`
        );
        throw new Error(
          `ltp_unavailable_dte0: Cannot price DTE=0 options without real LTP — ` +
          `Black-Scholes unreliable. Verify symbol format and Kite token.`
        );
      }
      premiumSource = "BLACK_SCHOLES_FALLBACK";
      logger.warn("⚠️ Option LTP fetch incomplete — using Black-Scholes estimate", {
        sellSymbol, sellLTP,
        buySymbol,  buyLTP,
        asset,
      });
    }
  }

  // ── Step 3: Recompute all financials from actual premiums ────────────────────
  // spreadWidth is deterministic (strike difference, not dependent on premiums).
  const spreadWidth    = Math.abs(spreadDetails.sellStrike - spreadDetails.buyStrike);
  const netCredit      = sellLegPremium - buyLegPremium;
  const maxLossPerPt   = Math.max(1, spreadWidth - netCredit); // floor at 1 to avoid division by zero
  const maxLossPerLot  = maxLossPerPt * lotSize;

  const maxRiskAmount  = (paperCapital * RISK_PER_TRADE_PCT) / 100;
  const lots           = Math.max(1, Math.floor(maxRiskAmount / maxLossPerLot));

  // ── Step 3.5: Margin check ──────────────────────────────────────────────────
  // Fetch SPAN + exposure margin from Kite API (or estimate as fallback).
  // Block if margin exceeds MAX_MARGIN_UTILIZATION of available capital.
  const { margin: requiredMargin, source: marginSource } = await getSpreadMargin({
    asset,
    sellStrike: spreadDetails.sellStrike,
    buyStrike:  spreadDetails.buyStrike,
    optionType: kiteType,
    expiryDate,
    lotSize,
    lots,
  });

  if (requiredMargin > paperCapital) {
    logger.error(
      `❌ Blocking trade — insufficient capital for margin requirement`,
      { requiredMargin, paperCapital, asset, lots }
    );
    throw new Error(
      `insufficient_margin: Need ₹${requiredMargin.toFixed(0)}, have ₹${paperCapital.toFixed(0)}`
    );
  }

  if (requiredMargin > paperCapital * MAX_MARGIN_UTILIZATION) {
    logger.warn(
      `⚠️ High margin usage: ₹${requiredMargin.toLocaleString("en-IN")} ` +
      `(${((requiredMargin / paperCapital) * 100).toFixed(1)}% of ₹${paperCapital.toLocaleString("en-IN")})`,
      { requiredMargin, marginSource, paperCapital, asset, lots }
    );
  }

  const maxProfit      = netCredit     * lotSize * lots;
  const maxLossTotal   = maxLossPerLot * lots;

  const breakeven =
    spreadDetails.strategy === "BULL_PUT_SPREAD"
      ? spreadDetails.sellStrike - netCredit
      : spreadDetails.sellStrike + netCredit;

  const riskRewardRatio = maxLossTotal === 0 ? 0 : maxProfit / maxLossTotal;

  // ── Step 4: Build position document ─────────────────────────────────────────
  const positionId     = uuidv4();
  const entryTimestamp = new Date().toISOString();
  const expiryDateStr  = expiryDate.toISOString().slice(0, 10);

  const position: OptionsPosition = {
    positionId,
    sessionId,
    asset,
    strategy: spreadDetails.strategy,
    legs: [
      {
        action: "SELL",
        type: legType,
        strike: spreadDetails.sellStrike,
        expiry: expiryDateStr,
        lotSize,
        lots,
        entryPremium: sellLegPremium,
        exitPremium: null,
        legPnL: null,
      },
      {
        action: "BUY",
        type: legType,
        strike: spreadDetails.buyStrike,
        expiry: expiryDateStr,
        lotSize,
        lots,
        entryPremium: buyLegPremium,
        exitPremium: null,
        legPnL: null,
      },
    ],
    entrySpot,
    entryDTE,
    entryIVRank: 50,
    entryTimestamp,
    maxProfit,
    maxLoss: maxLossTotal,
    breakevenPoint: breakeven,
    riskRewardRatio,
    status: "OPEN",
    exitSpot: null,
    exitTimestamp: null,
    exitReason: null,
    realizedPnL: null,
    dataMode,
    premiumSource,
    entryATR,
    requiredMargin,
    marginSource,
  };

  const saved = await OptionsPositionModel.create(position);
  logger.info("Paper position opened", {
    sessionId,
    asset,
    positionId,
    strategy: spreadDetails.strategy,
    lots,
    lotSize,
    premiumSource,
    sellLegPremium,
    buyLegPremium,
    netCredit:       parseFloat(netCredit.toFixed(2)),
    netCreditRupees: Math.round(netCredit * lotSize),
    maxProfit,
    maxLoss: maxLossTotal,
    requiredMargin,
    marginSource,
  });

  return saved.toObject() as OptionsPosition;
}

/**
 * Closes an existing paper position and realizes P&L based on exit conditions.
 * For MVP-1, realized P&L uses a simple maxProfit/maxLoss heuristic per close reason.
 * TIME_EXIT and SESSION_STOP accept an optional currentPnL override for accuracy.
 *
 * @param positionId - Identifier of the position to close.
 * @param exitSpot - Current underlying spot price at closure.
 * @param exitReason - Reason for closing (SL_HIT, TARGET_HIT, TIME_EXIT, etc.).
 * @param currentPnL - Optional actual PnL at close. When provided, always used directly.
 *   Pass this for SL_HIT (50% stop), TIME_EXIT, and SESSION_STOP to record accurate PnL.
 *   Omit for TARGET_HIT / EOD closes where max-profit heuristic is acceptable.
 * @returns Promise resolving to the updated OptionsPosition.
 */
export async function closePosition(
  positionId: string,
  exitSpot: number,
  exitReason: OptionsPosition["exitReason"],
  currentPnL?: number
): Promise<OptionsPosition> {
  const positionDoc = await OptionsPositionModel.findOne({ positionId });
  if (!positionDoc) {
    throw new Error(`Position not found: ${positionId}`);
  }

  let realizedPnL = 0;
  let exitPremiumSource: "KITE_LTP" | "ESTIMATED" = "ESTIMATED";

  // ── Attempt to fetch real exit LTPs from Kite ────────────────────────────────
  // If successful, compute accurate realized PnL from actual option premiums.
  // For a credit spread:
  //   Entry: received (sellEntry - buyEntry) per point
  //   Exit:  pays back (sellExit - buyExit) per point
  //   PnL  = (entryCredit - exitCost) × lots × lotSize
  const sellLeg = positionDoc.legs[0];
  const buyLeg  = positionDoc.legs[1];

  if (!isMock() && sellLeg && buyLeg && sellLeg.expiry) {
    try {
      const kiteType: "CE" | "PE" = sellLeg.type === "CALL" ? "CE" : "PE";
      const expiryDate = new Date(sellLeg.expiry); // "YYYY-MM-DD" → midnight UTC is fine
      const sellSymbol = buildNFOOptionSymbol(
        positionDoc.asset as AssetKey, expiryDate, sellLeg.strike, kiteType
      );
      const buySymbol  = buildNFOOptionSymbol(
        positionDoc.asset as AssetKey, expiryDate, buyLeg.strike,  kiteType
      );

      const [exitSellLTP, exitBuyLTP] = await Promise.all([
        fetchOptionLTP(sellSymbol),
        fetchOptionLTP(buySymbol),
      ]);

      if (exitSellLTP !== null && exitBuyLTP !== null) {
        const entryCredit = sellLeg.entryPremium - buyLeg.entryPremium;
        const exitCost    = exitSellLTP - exitBuyLTP;
        const lots        = sellLeg.lots;
        const lotSize     = sellLeg.lotSize;
        realizedPnL = parseFloat(((entryCredit - exitCost) * lots * lotSize).toFixed(2));
        exitPremiumSource = "KITE_LTP";

        // Persist real exit premiums on each leg
        positionDoc.legs[0]!.exitPremium = exitSellLTP;
        positionDoc.legs[0]!.legPnL      = parseFloat(((sellLeg.entryPremium - exitSellLTP) * lots * lotSize).toFixed(2));
        positionDoc.legs[1]!.exitPremium = exitBuyLTP;
        positionDoc.legs[1]!.legPnL      = parseFloat(((exitBuyLTP - buyLeg.entryPremium) * lots * lotSize).toFixed(2));

        logger.info("✅ Real exit premiums fetched from Kite", {
          positionId, sellSymbol, exitSellLTP, buySymbol, exitBuyLTP,
          entryCredit, exitCost, realizedPnL,
        });
      } else {
        logger.warn("⚠️ Exit LTP fetch incomplete — using estimated PnL", {
          positionId, exitSellLTP, exitBuyLTP,
        });
      }
    } catch (err) {
      logger.warn("Exit LTP fetch failed — using estimated PnL", {
        positionId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Must mark subdocument array as modified so Mongoose flushes the leg
  // mutations to MongoDB — without this, updates to nested objects are silently dropped.
  positionDoc.markModified("legs");

  // ── Fall back to estimated PnL if real LTPs unavailable ──────────────────────
  if (exitPremiumSource === "ESTIMATED") {
    if (currentPnL !== undefined) {
      // Caller provided actual PnL (e.g. 50% SL, TIME_EXIT) — use it directly.
      realizedPnL = currentPnL;
    } else if (exitReason === "SL_HIT") {
      realizedPnL = -positionDoc.maxLoss;
    } else if (
      exitReason === "TARGET_HIT" ||
      exitReason === "EOD_CLOSE" ||
      exitReason === "EOD_FORCED_CLOSE"
    ) {
      realizedPnL = positionDoc.maxProfit;
    } else {
      realizedPnL = 0;
    }

    // ── Derive estimated leg exit premiums from the decided realizedPnL ────────
    // We attribute all PnL to the sell leg (the net-credit leg of the spread),
    // treating the buy-leg protection cost as a constant at the estimated path.
    // Formula: sellExit = sellEntry − (pnlPerUnit)  where pnlPerUnit = realizedPnL / (lots × lotSize)
    const _sellLeg = positionDoc.legs[0];
    const _buyLeg  = positionDoc.legs[1];
    if (_sellLeg && _buyLeg) {
      const lots    = _sellLeg.lots;
      const lotSize = _sellLeg.lotSize;
      const units   = lots * lotSize;
      // Avoid division-by-zero for degenerate lot configs
      const pnlPerUnit = units > 0 ? realizedPnL / units : 0;
      // Sell leg exit premium: entryPremium minus the per-unit gain (seller earns when premium decays)
      const estimatedSellExit = parseFloat(Math.max(0, _sellLeg.entryPremium - pnlPerUnit).toFixed(2));
      // Buy leg: protective leg, assume it expired worthless or at entry value in estimated mode
      const estimatedBuyExit  = _buyLeg.entryPremium;

      _sellLeg.exitPremium = estimatedSellExit;
      _sellLeg.legPnL      = parseFloat(((_sellLeg.entryPremium - estimatedSellExit) * units).toFixed(2));
      _buyLeg.exitPremium  = estimatedBuyExit;
      _buyLeg.legPnL       = 0; // buy leg cost is a wash in estimated mode

      logger.info("📊 Estimated exit premiums derived from realizedPnL", {
        positionId,
        realizedPnL,
        estimatedSellExit,
        estimatedBuyExit,
        sellLegPnL: _sellLeg.legPnL,
      });
    }
  }

  positionDoc.status =
    exitReason === "SL_HIT"
      ? "CLOSED_SL"
      : exitReason === "TARGET_HIT"
      ? "CLOSED_TARGET"
      : "CLOSED_MANUAL";

  positionDoc.exitSpot      = exitSpot;
  positionDoc.exitTimestamp = new Date().toISOString();
  positionDoc.exitReason    = exitReason;
  positionDoc.realizedPnL   = realizedPnL;

  await positionDoc.save();

  logger.info("Paper position closed", {
    positionId,
    exitReason,
    realizedPnL,
    exitPremiumSource,
  });

  return positionDoc.toObject() as OptionsPosition;
}

/**
 * Retrieves all currently open positions for a session.
 * This is used by both the signal loop and portfolio monitor.
 *
 * @param sessionId - Identifier of the monitoring session.
 * @returns Promise resolving to an array of open OptionsPosition objects.
 */
export async function getOpenPositions(
  sessionId: string
): Promise<OptionsPosition[]> {
  const docs = await OptionsPositionModel.find({
    sessionId,
    status: "OPEN",
  }).exec();
  return docs.map((d) => d.toObject() as OptionsPosition);
}

/**
 * Retrieves a paginated history of positions for a session.
 * This is designed for dashboards and offline analysis.
 *
 * @param sessionId - Monitoring session identifier.
 * @param limit - Max number of records to return.
 * @param offset - Number of records to skip.
 * @returns Promise resolving to an array of historical OptionsPosition objects.
 */
export async function getPositionHistory(
  sessionId: string,
  limit: number,
  offset: number
): Promise<OptionsPosition[]> {
  const docs = await OptionsPositionModel.find({ sessionId })
    .sort({ timestamp: -1 })
    .skip(offset)
    .limit(limit)
    .exec();

  return docs.map((d) => d.toObject() as OptionsPosition);
}

/**
 * Estimates current unrealized P&L of a credit spread using actual option premiums.
 *
 * For a credit spread, the theoretical PnL at any point is:
 *   PnL = (entryCredit − currentExitCost) × lots × lotSize
 *
 * We estimate `currentExitCost` (the cost to close the spread right now) by
 * scaling the entry credit proportionally to how far the underlying has moved
 * relative to the width of the spread. This is more accurate than a raw
 * spot-delta heuristic because it anchors to the actual premiums received.
 *
 * When leg premium data is unavailable, falls back to the original linear
 * approximation for safety.
 *
 * @param position - The open options position to value.
 * @param currentLTP - Current underlying last traded price.
 * @returns A numeric P&L estimate (positive for profit, negative for loss).
 */
export function calculateCurrentPnL(
  position: OptionsPosition,
  currentLTP: number
): number {
  const sellLeg = position.legs[0];
  const buyLeg  = position.legs[1];

  // ── Premium-based estimate (preferred) ────────────────────────────────────
  if (sellLeg && buyLeg && sellLeg.entryPremium > 0) {
    const lots    = sellLeg.lots;
    const lotSize = sellLeg.lotSize;

    const entryCredit = sellLeg.entryPremium - buyLeg.entryPremium;

    // Direction: BULL_PUT_SPREAD profits when spot rises (OTM put decays).
    // BEAR_CALL_SPREAD profits when spot falls (OTM call decays).
    const direction = position.strategy === "BULL_PUT_SPREAD" ? 1 : -1;
    const spotMove  = (currentLTP - position.entrySpot) * direction;

    // Spread width gives us the natural range for the exit cost.
    // When spotMove ≥ spreadWidth → position is fully profitable (exitCost ≈ 0).
    // When spotMove ≤ −spreadWidth → position is at max loss (exitCost ≈ spreadWidth).
    const spreadWidth = Math.abs(
      position.legs[0]!.strike - position.legs[1]!.strike
    );

    // Normalise spot move into [-1, 1] range relative to spread width.
    const norm = spreadWidth > 0
      ? Math.max(-1, Math.min(1, spotMove / spreadWidth))
      : 0;

    // Estimated exit cost: full entryCredit when flat → 0 when fully profitable.
    // Use a linear interpolation: exitCost = entryCredit × (1 − norm)  clamped to [0, spreadWidth].
    const estimatedExitCost = Math.max(0, Math.min(spreadWidth, entryCredit * (1 - norm)));

    const pnl = (entryCredit - estimatedExitCost) * lots * lotSize;
    return parseFloat(Math.max(-position.maxLoss, Math.min(position.maxProfit, pnl)).toFixed(2));
  }

  // ── Fallback: original spot-delta heuristic ────────────────────────────────
  const direction =
    position.strategy === "BULL_PUT_SPREAD" ? 1 : -1;
  const move = (currentLTP - position.entrySpot) * direction;
  const sensitivity = 0.3;
  const gross = move * sensitivity * (sellLeg?.lotSize ?? 0) * (sellLeg?.lots ?? 0);
  return Math.max(-position.maxLoss, Math.min(position.maxProfit, gross));
}

/**
 * Returns all positions for a session whose entryTimestamp falls on today's IST date,
 * regardless of current status (open, closed, expired).
 * Used by the risk guard to enforce the daily trade limit.
 *
 * @param sessionId - Monitoring session identifier.
 * @returns Promise resolving to all positions entered today (any status).
 */
export async function getTodayPositions(
  sessionId: string
): Promise<OptionsPosition[]> {
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const docs = await OptionsPositionModel.find({
    sessionId,
    entryTimestamp: { $regex: `^${today}` },
  }).exec();
  return docs.map((d) => d.toObject() as OptionsPosition);
}

/**
 * Computes the realized P&L for all closed positions of a session on the current day.
 * This is used by risk guards and dashboards to track intraday performance.
 *
 * @param sessionId - Monitoring session identifier.
 * @returns Promise resolving to total realized P&L for today.
 */
export async function getDailyPnL(
  sessionId: string
): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);

  const docs = await OptionsPositionModel.find({
    sessionId,
    exitTimestamp: { $regex: `^${today}` },
    status: { $ne: "OPEN" },
  }).exec();

  return docs.reduce(
    (sum, d) => sum + (d.realizedPnL ?? 0),
    0
  );
}

