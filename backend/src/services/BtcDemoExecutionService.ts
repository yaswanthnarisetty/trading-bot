import crypto from "crypto";
import { planBtcDemoTrade, planBtcPriorDayTrade, type BtcDemoPlan } from "../domain/btcDemoPlan";
import { BtcDemoOrderIntentModel, type BtcDemoOrderIntent } from "../models/BtcDemoOrderIntent";
import { BtcDemoAutoControlModel } from "../models/BtcDemoAutoControl";
import { btcDemoStrategyMeetsResearchGate, type BtcBacktestResult } from "./BtcResearchService";
import { getDeltaDemoAccount, getDeltaDemoBtcExposure, getDeltaDemoProduct,
  getDeltaDemoRecentFills, getDeltaDemoBtcBook, getDeltaDemoCompletedDailyCandles,
  getDeltaPrice } from "./DeltaService";
import { getDeltaOrderByClientId, submitDeltaProtectedEntry, submitDeltaReduceOnlyClose } from "./DeltaDemoBroker";
import { evaluateCryptoSignal, isActionableSignal } from "./CryptoSignalService";
import { decideBtcDailyBreakout } from "./BtcDailyResearchService";
import { btcThreeLossCooldownActive } from "../domain/btcDailyAutoPolicy";
import { logger } from "../utils/logger";

type EligiblePlan = Extract<BtcDemoPlan, { eligible: true }>;
const SLOT = "BTCUSD:DELTA_DEMO";
const DAILY_ID = "BTC_DAILY_FORWARD_DEMO_V1";
const DAY_MS = 86_400_000;

function clientId(prefix: string): string { return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`; }
function code(error: unknown): string { return error instanceof Error ? error.message.slice(0, 120) : "UNKNOWN"; }
function fillTimeMs(createdAt: string): number {
  const parsed = /^\d+$/.test(createdAt) ? Number(createdAt) / 1000 : Date.parse(createdAt);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("BTC_FILL_TIME_INVALID");
  return parsed;
}

async function attention(clientOrderId: string, reason: string): Promise<void> {
  const changed = await BtcDemoOrderIntentModel.updateOne({ clientOrderId,
    $or: [{ status: { $ne: "ATTENTION" } }, { attentionReason: { $ne: reason } }],
  }, { $set: {
    status: "ATTENTION", attentionReason: reason,
  } }).exec();
  if (changed.modifiedCount) logger.error("BTC Demo order requires attention", { clientOrderId, reason });
}

/**
 * Broker state always wins over local projections. This read-only broker pass
 * never resubmits an uncertain POST. An unresolved intent retains the unique
 * active slot and prevents new entries across restarts.
 */
export async function reconcileBtcDemoIntent(clientOrderId: string): Promise<BtcDemoOrderIntent> {
  const intent = await BtcDemoOrderIntentModel.findOne({ clientOrderId }).lean().exec();
  if (!intent) throw new Error("BTC_INTENT_NOT_FOUND");
  if (intent.status === "CANCELLED_UNFILLED" || intent.status === "CLOSED_CONFIRMED") return intent;
  try {
    const [order, exposure, fills] = await Promise.all([
      getDeltaOrderByClientId(clientOrderId), getDeltaDemoBtcExposure(intent.productId),
      getDeltaDemoRecentFills(intent.productId),
    ]);
    if (order.productId !== intent.productId || order.reduceOnly ||
        order.side !== (intent.side === "LONG" ? "buy" : "sell") ||
        order.sizeContracts !== intent.sizeContracts || order.bracketStopUsd !== intent.stopUsd ||
        order.bracketTargetUsd !== intent.targetUsd)
      throw new Error("BTC_ENTRY_ORDER_OR_BRACKET_MISMATCH");
    const entryFills = fills.filter(fill => fill.orderId === order.id);
    const filled = order.sizeContracts - order.unfilledContracts;
    if (entryFills.reduce((sum, fill) => sum + fill.sizeContracts, 0) !== filled ||
        entryFills.some(fill => fill.side !== order.side))
      throw new Error("BTC_ENTRY_FILLS_MISMATCH");
    if (filled === 0) {
      if (exposure.sizeContracts !== 0) throw new Error("BTC_UNATTRIBUTED_EXCHANGE_EXPOSURE");
      const terminal = order.state === "cancelled";
      await BtcDemoOrderIntentModel.updateOne({ clientOrderId }, { $set: {
        status: terminal ? "CANCELLED_UNFILLED" : "ORDER_ACKNOWLEDGED", orderId: order.id,
        ...(terminal ? { activeSlot: null } : {}),
      } }).exec();
    } else {
      if (!["closed", "cancelled"].includes(order.state) || exposure.activeOrders.some(active => active.id === order.id))
        throw new Error("BTC_ENTRY_ORDER_STILL_ACTIVE");
      const averageFillPriceUsd = entryFills.reduce((sum, fill) => sum + fill.priceUsd * fill.sizeContracts, 0) / filled;
      const estimatedLoss = Math.abs(averageFillPriceUsd - intent.stopUsd) * intent.contractValueBtc * filled
        + intent.costAllowanceUsd;
      if (estimatedLoss > intent.riskBudgetUsd) throw new Error("BTC_FILLED_RISK_EXCEEDS_BUDGET");
      const signedSize = intent.side === "LONG" ? filled : -filled;
      if (exposure.sizeContracts === signedSize) {
        if (intent.closeClientOrderId) {
          const closeOrder = await getDeltaOrderByClientId(intent.closeClientOrderId);
          if (!closeOrder.reduceOnly || closeOrder.productId !== intent.productId ||
              closeOrder.side !== (intent.side === "LONG" ? "sell" : "buy") ||
              closeOrder.sizeContracts !== filled)
            throw new Error("BTC_CLOSE_ORDER_MISMATCH");
        }
        await BtcDemoOrderIntentModel.updateOne({ clientOrderId }, { $set: {
          status: intent.closeClientOrderId ? "CLOSE_REQUESTED" : "FILLED_PROTECTED",
          orderId: order.id, filledContracts: filled, averageFillPriceUsd,
          entryFillIds: entryFills.map(fill => fill.id), attentionReason: null,
        } }).exec();
      } else if (exposure.sizeContracts === 0) {
        const firstEntryTime = Math.min(...entryFills.map(fill => fillTimeMs(fill.createdAt)));
        const oppositeSide = intent.side === "LONG" ? "sell" : "buy";
        let closeOrderId = intent.closeOrderId;
        if (intent.closeClientOrderId) {
          const closeOrder = await getDeltaOrderByClientId(intent.closeClientOrderId);
          if (!closeOrder.reduceOnly || closeOrder.productId !== intent.productId ||
              closeOrder.side !== oppositeSide || closeOrder.sizeContracts !== filled ||
              closeOrder.unfilledContracts !== 0 || closeOrder.state !== "closed" ||
              (closeOrderId && closeOrder.id !== closeOrderId))
            throw new Error("BTC_CLOSE_ORDER_MISMATCH");
          closeOrderId = closeOrder.id;
        }
        const exits = fills.filter(fill => fill.orderId !== order.id && fill.side === oppositeSide &&
          (!closeOrderId || fill.orderId === closeOrderId) && fillTimeMs(fill.createdAt) >= firstEntryTime);
        if (exits.reduce((sum, fill) => sum + fill.sizeContracts, 0) !== filled ||
            exposure.activeOrders.length !== 0)
          throw new Error("BTC_FLAT_WITHOUT_MATCHED_EXIT_FILLS");
        const averageExit = exits.reduce((sum, fill) => sum + fill.priceUsd * fill.sizeContracts, 0) / filled;
        const direction = intent.side === "LONG" ? 1 : -1;
        const commissions = [...entryFills, ...exits].reduce((sum, fill) => sum + fill.commissionUsd, 0);
        const realizedPnlUsd = (averageExit - averageFillPriceUsd) * direction * intent.contractValueBtc * filled - commissions;
        await BtcDemoOrderIntentModel.updateOne({ clientOrderId }, { $set: {
          status: "CLOSED_CONFIRMED", activeSlot: null, orderId: order.id, filledContracts: filled,
          averageFillPriceUsd, entryFillIds: entryFills.map(fill => fill.id), exitFillIds: exits.map(fill => fill.id),
          realizedPnlUsd, averageExitPriceUsd: averageExit, closeOrderId: closeOrderId ?? null,
          attentionReason: null,
        } }).exec();
      } else throw new Error("BTC_EXCHANGE_POSITION_MISMATCH");
    }
  } catch (error) {
    await attention(clientOrderId, code(error));
  }
  const updated = await BtcDemoOrderIntentModel.findOne({ clientOrderId }).lean().exec();
  if (!updated) throw new Error("BTC_INTENT_DISAPPEARED");
  return updated;
}

/** No public route calls this until a current, cost-aware strategy passes validation. */
export async function submitBtcDemoCandidate(input: {
  plan: EligiblePlan; signalTimestamp: string; outOfSampleResults: readonly BtcBacktestResult[];
}): Promise<BtcDemoOrderIntent> {
  const { plan, signalTimestamp, outOfSampleResults } = input;
  if (!btcDemoStrategyMeetsResearchGate(outOfSampleResults)) throw new Error("BTC_STRATEGY_NOT_VALIDATED");
  const signalAge = Date.now() - Date.parse(signalTimestamp);
  if (!Number.isFinite(signalAge) || signalAge < 0 || signalAge > 120_000)
    throw new Error("BTC_SIGNAL_STALE");
  const validationId = crypto.createHash("sha256").update(JSON.stringify(outOfSampleResults)).digest("hex").slice(0, 24);
  return submitBtcDemoPlan(plan, validationId, true);
}

/** An explicit, one-contract exchange plumbing check. It never enables strategy trading. */
export async function submitBtcDemoSmoke(): Promise<BtcDemoOrderIntent> {
  if (process.env.BTC_DEMO_SMOKE !== "ENABLED") throw new Error("BTC_DEMO_SMOKE_NOT_ENABLED");
  const [product, account, price, signal] = await Promise.all([
    getDeltaDemoProduct(), getDeltaDemoAccount(), getDeltaPrice("BTCUSD"), evaluateCryptoSignal("BTCUSD"),
  ]);
  const plan = planBtcDemoTrade({ side: "LONG", entryPrice: price, atr: signal.atr,
    equityUsd: account.equity, product, openPositionCount: account.openPositionCount,
    activeOrderCount: account.activeOrderCount });
  if (!plan.eligible || plan.contractCount !== 1) throw new Error("BTC_SMOKE_ONE_CONTRACT_INELIGIBLE");
  return submitBtcDemoPlan(plan, "BROKER_SMOKE_V1", false);
}

/** The user's explicit Demo forward experiment. This does not claim historical validation. */
export async function submitBtcDemoDailyCandidate(): Promise<BtcDemoOrderIntent> {
  if (process.env.BTC_DEMO_AUTO_TRADING !== "ENABLED") throw new Error("BTC_DEMO_AUTO_DISABLED");
  if ((await BtcDemoAutoControlModel.findOne({ key: SLOT }).lean().exec())?.paused === true)
    throw new Error("BTC_DEMO_AUTO_OPERATOR_PAUSED");
  const todayMs = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  if (Date.now() - todayMs > 5 * 60_000) throw new Error("BTC_DAILY_ENTRY_WINDOW_CLOSED");
  const recent = await BtcDemoOrderIntentModel.find({ status: "CLOSED_CONFIRMED", validationId: DAILY_ID })
    .sort({ updatedAt: -1 }).limit(3).lean().exec();
  if (btcThreeLossCooldownActive(recent, Date.now()))
    throw new Error("BTC_THREE_LOSSES_THREE_DAYS_OFF");
  const [bars, product, account, price] = await Promise.all([
    getDeltaDemoCompletedDailyCandles(), getDeltaDemoProduct(), getDeltaDemoAccount(), getDeltaPrice("BTCUSD"),
  ]);
  if (bars[59]!.timestamp.getTime() !== todayMs - DAY_MS)
    throw new Error("BTC_DAILY_SIGNAL_STALE");
  const decision = decideBtcDailyBreakout(bars);
  if (!decision) throw new Error("BTC_DAILY_NO_CLEAN_SETUP");
  const plan = planBtcPriorDayTrade({ side: decision.side, entryPrice: price,
    stopReferenceUsd: decision.stopReferenceUsd, equityUsd: account.equity, product,
    openPositionCount: account.openPositionCount, activeOrderCount: account.activeOrderCount });
  if (!plan.eligible) throw new Error(plan.reason);
  return submitBtcDemoPlan(plan, DAILY_ID, false, new Date(todayMs).toISOString().slice(0, 10));
}

async function submitBtcDemoPlan(plan: EligiblePlan, validationId: string,
  requireActionableSignal: boolean, dailyDay?: string): Promise<BtcDemoOrderIntent> {
  const [product, account, exposure, price, signal] = await Promise.all([
    getDeltaDemoProduct(), getDeltaDemoAccount(), getDeltaDemoBtcExposure(plan.productId),
    getDeltaPrice("BTCUSD"), dailyDay ? Promise.resolve(null) : evaluateCryptoSignal("BTCUSD"),
  ]);
  if (requireActionableSignal && (!signal || !isActionableSignal(signal) || signal.side !== plan.side))
    throw new Error("BTC_SIGNAL_NOT_ACTIONABLE");
  if (product.id !== plan.productId || !Number.isSafeInteger(plan.contractCount) || plan.contractCount <= 0 ||
      account.equity <= 0 || account.openPositionCount !== 0 || account.activeOrderCount !== 0 ||
      exposure.sizeContracts !== 0 || exposure.activeOrders.length !== 0)
    throw new Error("BTC_EXCHANGE_NOT_FLAT");
  if (!Number.isFinite(plan.entryReferenceUsd) || plan.entryReferenceUsd <= 0 ||
      Math.abs(price - plan.entryReferenceUsd) / plan.entryReferenceUsd > 0.002)
    throw new Error("BTC_ENTRY_PRICE_MOVED");
  const freshPlan = dailyDay ? planBtcPriorDayTrade({ side: plan.side, entryPrice: price,
    stopReferenceUsd: plan.stopReferenceUsd, equityUsd: account.equity, product,
    openPositionCount: 0, activeOrderCount: 0 }) : planBtcDemoTrade({ side: plan.side,
    entryPrice: price, atr: signal!.atr, equityUsd: account.equity, product,
    openPositionCount: 0, activeOrderCount: 0 });
  if (!freshPlan.eligible || freshPlan.contractCount !== plan.contractCount)
    throw new Error("BTC_PLAN_STALE_OR_MISMATCH");
  const book = await getDeltaDemoBtcBook(freshPlan.contractCount);
  const bookMid = (book.bidUsd + book.askUsd) / 2;
  if (Math.abs(bookMid - price) / price > 0.002) throw new Error("BTC_BOOK_MARK_DIVERGENCE");
  const executablePrice = plan.side === "LONG" ? book.executionAskUsd : book.executionBidUsd;
  const notionalUsd = executablePrice * product.contractValueBtc * freshPlan.contractCount;
  const allowanceUsd = notionalUsd * 0.003;
  const stopLossUsd = Math.abs(executablePrice - freshPlan.stopReferenceUsd) *
    product.contractValueBtc * freshPlan.contractCount;
  if (!Number.isFinite(freshPlan.stopReferenceUsd) || !Number.isFinite(freshPlan.takeProfitReferenceUsd) ||
      !(plan.side === "LONG" ? freshPlan.stopReferenceUsd < price && freshPlan.takeProfitReferenceUsd > price
                              : freshPlan.stopReferenceUsd > price && freshPlan.takeProfitReferenceUsd < price) ||
      !Number.isFinite(freshPlan.riskBudgetUsd) || freshPlan.riskBudgetUsd <= 0 ||
      notionalUsd > account.equity || stopLossUsd + allowanceUsd > account.equity * 0.005 ||
      stopLossUsd + allowanceUsd > freshPlan.riskBudgetUsd)
    throw new Error("BTC_RISK_PLAN_EXCEEDED");
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const firstToday = await BtcDemoOrderIntentModel.findOne({ createdAt: { $gte: dayStart } })
    .sort({ createdAt: 1 }).lean().exec();
  const dayEquity = firstToday?.equityAtEntryUsd ?? account.equity;
  if (account.equity <= dayEquity * 0.98) throw new Error("BTC_DAILY_LOSS_LIMIT");
  if (dailyDay && (new Date(Date.now()).toISOString().slice(0, 10) !== dailyDay ||
      Date.now() - Date.parse(`${dailyDay}T00:00:00.000Z`) > 5 * 60_000))
    throw new Error("BTC_DAILY_ENTRY_WINDOW_CLOSED");
  const clientOrderId = clientId("btce");
  try {
    await BtcDemoOrderIntentModel.create({ clientOrderId, activeSlot: SLOT, status: "PREPARED",
      ...(dailyDay ? { dailySlot: `${SLOT}:${dailyDay}` } : {}),
      productId: product.id, side: plan.side, sizeContracts: freshPlan.contractCount,
      referencePriceUsd: price, stopUsd: freshPlan.stopReferenceUsd,
      targetUsd: freshPlan.takeProfitReferenceUsd, tickSize: product.tickSize,
      contractValueBtc: product.contractValueBtc, riskBudgetUsd: freshPlan.riskBudgetUsd,
      costAllowanceUsd: allowanceUsd, equityAtEntryUsd: account.equity, validationId });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const duplicate = error as { keyPattern?: Record<string, unknown> };
      throw new Error(duplicate.keyPattern?.dailySlot ? "BTC_DAILY_ALREADY_ATTEMPTED" :
        "BTC_ACTIVE_INTENT_OR_POSITION");
    }
    throw error;
  }
  // The account can change between the initial read and durable reservation.
  // Recheck immediately before the one and only submission attempt.
  try {
    const [freshAccount, freshExposure, freshPrice, freshBook] = await Promise.all([
      getDeltaDemoAccount(), getDeltaDemoBtcExposure(product.id), getDeltaPrice("BTCUSD"),
      getDeltaDemoBtcBook(freshPlan.contractCount),
    ]);
    if (dailyDay && (await BtcDemoAutoControlModel.findOne({ key: SLOT }).lean().exec())?.paused === true)
      throw new Error("BTC_DEMO_AUTO_OPERATOR_PAUSED");
    if (freshAccount.openPositionCount !== 0 || freshAccount.activeOrderCount !== 0 ||
        freshExposure.sizeContracts !== 0 || freshExposure.activeOrders.length !== 0 ||
        Math.abs(freshPrice - price) / price > 0.002 ||
        (dailyDay && (new Date(Date.now()).toISOString().slice(0, 10) !== dailyDay ||
          Date.now() - Date.parse(`${dailyDay}T00:00:00.000Z`) > 5 * 60_000)) ||
        Math.abs((freshBook.bidUsd + freshBook.askUsd) / 2 - freshPrice) / freshPrice > 0.002)
      throw new Error("BTC_PRE_SEND_EVIDENCE_CHANGED");
    const finalExecutable = plan.side === "LONG" ? freshBook.executionAskUsd : freshBook.executionBidUsd;
    const finalNotional = finalExecutable * product.contractValueBtc * freshPlan.contractCount;
    const finalLoss = Math.abs(finalExecutable - freshPlan.stopReferenceUsd) *
      product.contractValueBtc * freshPlan.contractCount + finalNotional * 0.003;
    if (finalNotional > freshAccount.equity || finalLoss > freshAccount.equity * 0.005 ||
        finalLoss > freshPlan.riskBudgetUsd ||
        freshAccount.equity <= dayEquity * 0.98)
      throw new Error("BTC_PRE_SEND_RISK_CHANGED");
  } catch (error) {
    await BtcDemoOrderIntentModel.updateOne({ clientOrderId, status: "PREPARED" }, { $set: {
      status: "CANCELLED_UNFILLED", activeSlot: null,
      attentionReason: `PRE_SEND_REJECTED:${code(error)}`,
    } }).exec();
    throw error;
  }
  try {
    const order = await submitDeltaProtectedEntry({ clientOrderId, productId: product.id, side: plan.side,
      sizeContracts: freshPlan.contractCount, referencePriceUsd: price, stopUsd: freshPlan.stopReferenceUsd,
      targetUsd: freshPlan.takeProfitReferenceUsd, tickSize: product.tickSize });
    await BtcDemoOrderIntentModel.updateOne({ clientOrderId, status: "PREPARED" }, { $set: {
      status: "ORDER_ACKNOWLEDGED", orderId: order.id,
    } }).exec();
  } catch (error) {
    await attention(clientOrderId, `ENTRY_SUBMISSION_UNCERTAIN:${code(error)}`);
    throw error;
  }
  return reconcileBtcDemoIntent(clientOrderId);
}

/** Persist the close ID first; an uncertain POST is never automatically retried. */
export async function requestBtcDemoClose(clientOrderId: string): Promise<BtcDemoOrderIntent> {
  const intent = await BtcDemoOrderIntentModel.findOne({ clientOrderId, status: "FILLED_PROTECTED" }).lean().exec();
  if (!intent || !intent.filledContracts) throw new Error("BTC_PROTECTED_POSITION_REQUIRED");
  const exposure = await getDeltaDemoBtcExposure(intent.productId);
  if (exposure.sizeContracts !== (intent.side === "LONG" ? intent.filledContracts : -intent.filledContracts))
    throw new Error("BTC_EXCHANGE_POSITION_MISMATCH");
  const closeClientOrderId = clientId("btcx");
  const reserved = await BtcDemoOrderIntentModel.updateOne({ clientOrderId, status: "FILLED_PROTECTED",
    closeClientOrderId: null }, { $set: { status: "CLOSE_REQUESTED", closeClientOrderId } }).exec();
  if (reserved.modifiedCount !== 1) throw new Error("BTC_CLOSE_ALREADY_REQUESTED");
  try {
    const order = await submitDeltaReduceOnlyClose({ clientOrderId: closeClientOrderId,
      productId: intent.productId, side: intent.side, sizeContracts: intent.filledContracts });
    await BtcDemoOrderIntentModel.updateOne({ clientOrderId }, { $set: { closeOrderId: order.id } }).exec();
  } catch (error) {
    await attention(clientOrderId, `CLOSE_SUBMISSION_UNCERTAIN:${code(error)}`);
    throw error;
  }
  return reconcileBtcDemoIntent(clientOrderId);
}

/** Closes a confirmed Demo exposure even if bracket reconciliation raised ATTENTION. */
export async function requestBtcDemoEmergencyClose(clientOrderId: string): Promise<BtcDemoOrderIntent> {
  const intent = await BtcDemoOrderIntentModel.findOne({ clientOrderId, activeSlot: SLOT,
    status: { $in: ["ATTENTION", "ORDER_ACKNOWLEDGED", "FILLED_PROTECTED"] },
    closeClientOrderId: null }).lean().exec();
  if (!intent) throw new Error("BTC_EMERGENCY_CLOSE_INTENT_REQUIRED");
  const [entryOrder, exposure, fills] = await Promise.all([
    getDeltaOrderByClientId(clientOrderId), getDeltaDemoBtcExposure(intent.productId),
    getDeltaDemoRecentFills(intent.productId),
  ]);
  const signedSize = intent.side === "LONG" ? intent.sizeContracts : -intent.sizeContracts;
  const entryFills = fills.filter(fill => fill.orderId === entryOrder.id);
  if (entryOrder.clientOrderId !== clientOrderId || entryOrder.productId !== intent.productId ||
      entryOrder.side !== (intent.side === "LONG" ? "buy" : "sell") || entryOrder.reduceOnly ||
      entryOrder.sizeContracts !== intent.sizeContracts || exposure.sizeContracts !== signedSize ||
      entryFills.reduce((sum, fill) => sum + fill.sizeContracts, 0) !== intent.sizeContracts ||
      entryFills.some(fill => fill.side !== entryOrder.side))
    throw new Error("BTC_EMERGENCY_CLOSE_EVIDENCE_MISMATCH");
  const closeClientOrderId = clientId("btcx");
  const reserved = await BtcDemoOrderIntentModel.updateOne({ clientOrderId, activeSlot: SLOT,
    status: intent.status, closeClientOrderId: null }, { $set: {
      status: "CLOSE_REQUESTED", closeClientOrderId, filledContracts: intent.sizeContracts,
      entryFillIds: entryFills.map(fill => fill.id),
    } }).exec();
  if (reserved.modifiedCount !== 1) throw new Error("BTC_CLOSE_ALREADY_REQUESTED");
  try {
    const order = await submitDeltaReduceOnlyClose({ clientOrderId: closeClientOrderId,
      productId: intent.productId, side: intent.side, sizeContracts: intent.sizeContracts });
    await BtcDemoOrderIntentModel.updateOne({ clientOrderId }, { $set: { closeOrderId: order.id } }).exec();
  } catch (error) {
    await attention(clientOrderId, `EMERGENCY_CLOSE_UNCERTAIN:${code(error)}`);
    throw error;
  }
  return reconcileBtcDemoIntent(clientOrderId);
}

/** Startup and periodic recovery only reads Delta and updates evidence. It never sends a new order. */
export async function recoverBtcDemoIntents(): Promise<void> {
  const intents = await BtcDemoOrderIntentModel.find({ activeSlot: SLOT }).select({ clientOrderId: 1 }).lean().exec();
  for (const intent of intents) await reconcileBtcDemoIntent(intent.clientOrderId);
}
