import { BtcDemoOrderIntentModel } from "../models/BtcDemoOrderIntent";
import { BtcDemoAutoControlModel } from "../models/BtcDemoAutoControl";
import { requestBtcDemoClose, submitBtcDemoDailyCandidate } from "./BtcDemoExecutionService";
import { logger } from "../utils/logger";

const SLOT = "BTCUSD:DELTA_DEMO";
const FIVE_DAYS_MS = 5 * 86_400_000;

export interface BtcDemoAutoStatus {
  configured: boolean;
  enabled: boolean;
  paused: boolean;
  checkedAt: string | null;
  state: "DISABLED" | "WAITING" | "BLOCKED" | "ORDER_SUBMITTED" | "CLOSE_REQUESTED";
  reason: string | null;
  clientOrderId: string | null;
}

let status: BtcDemoAutoStatus = { configured: false, enabled: false, paused: false,
  checkedAt: null, state: "DISABLED",
  reason: null, clientOrderId: null };
let running = false;
let timer: NodeJS.Timeout | null = null;

export function getBtcDemoAutoStatus(): BtcDemoAutoStatus {
  return { ...status, configured: process.env.BTC_DEMO_AUTO_TRADING === "ENABLED" };
}

/** A persisted operator pause survives process restarts; it never cancels a protected exit. */
export async function setBtcDemoAutoPaused(paused: boolean): Promise<BtcDemoAutoStatus> {
  await BtcDemoAutoControlModel.updateOne({ key: SLOT }, { $set: { paused } }, { upsert: true }).exec();
  const configured = process.env.BTC_DEMO_AUTO_TRADING === "ENABLED";
  status = { ...status, configured, enabled: configured && !paused, paused,
    checkedAt: new Date().toISOString(), state: configured && !paused ? "WAITING" : "DISABLED",
    reason: paused ? "OPERATOR_PAUSED" : configured ? "NEXT_UTC_DAILY_OPEN" : "BTC_DEMO_AUTO_DISABLED" };
  return getBtcDemoAutoStatus();
}

/** One in-process scanner. Durable active/daily slots protect restarts and duplicate instances. */
export async function runBtcDemoAutoCycle(): Promise<BtcDemoAutoStatus> {
  if (running) return getBtcDemoAutoStatus();
  running = true;
  try {
    const configured = process.env.BTC_DEMO_AUTO_TRADING === "ENABLED";
    const paused = configured && (await BtcDemoAutoControlModel.findOne({ key: SLOT }).lean().exec())?.paused === true;
    const enabled = configured && !paused;
    status = { configured, enabled, paused, checkedAt: new Date().toISOString(),
      state: enabled ? "WAITING" : "DISABLED",
      reason: paused ? "OPERATOR_PAUSED" : null, clientOrderId: null };
    const active = await BtcDemoOrderIntentModel.findOne({ activeSlot: SLOT }).lean().exec();
    if (active) {
      if (active.status === "FILLED_PROTECTED" && active.createdAt &&
          Date.now() - active.createdAt.getTime() >= FIVE_DAYS_MS) {
        const closed = await requestBtcDemoClose(active.clientOrderId);
        status = { ...status, state: "CLOSE_REQUESTED", reason: "FIVE_DAY_MAX_HOLD",
          clientOrderId: closed.clientOrderId };
      } else if (enabled) {
        status = { ...status, state: "BLOCKED", reason: "BTC_ACTIVE_INTENT_OR_POSITION",
          clientOrderId: active.clientOrderId };
      }
      return getBtcDemoAutoStatus();
    }
    if (!enabled) return getBtcDemoAutoStatus();
    // The historical model enters at the next UTC day open. A later intraday
    // entry would change the tested strategy, so it is never chased.
    const elapsed = Date.now() % 86_400_000;
    if (elapsed > 5 * 60_000) {
      status = { ...status, state: "WAITING", reason: "NEXT_UTC_DAILY_OPEN" };
      return getBtcDemoAutoStatus();
    }
    const placed = await submitBtcDemoDailyCandidate();
    status = { ...status, state: "ORDER_SUBMITTED", reason: placed.status,
      clientOrderId: placed.clientOrderId };
    return getBtcDemoAutoStatus();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "BTC_DEMO_AUTO_ERROR";
    status = { ...status, state: "BLOCKED", reason };
    if (!["BTC_DAILY_NO_CLEAN_SETUP", "MINIMUM_CONTRACT_EXCEEDS_RISK_OR_NOTIONAL_CAP",
      "BTC_DAILY_ENTRY_WINDOW_CLOSED", "BTC_THREE_LOSSES_THREE_DAYS_OFF",
      "BTC_DAILY_ALREADY_ATTEMPTED"].includes(reason))
      logger.warn("BTC Demo auto cycle blocked", { reason });
    return getBtcDemoAutoStatus();
  } finally {
    running = false;
  }
}

export function startBtcDemoAutoScheduler(): void {
  if (timer || process.env.BTC_DEMO_AUTO_TRADING !== "ENABLED") return;
  void runBtcDemoAutoCycle();
  timer = setInterval(() => { void runBtcDemoAutoCycle(); }, 30_000);
  timer.unref();
}
