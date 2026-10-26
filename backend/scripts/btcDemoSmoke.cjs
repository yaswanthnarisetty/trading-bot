// Run from backend/: node -r ts-node/register -r dotenv/config scripts/btcDemoSmoke.cjs --execute-demo-smoke
// This is an explicit one-contract Delta Demo plumbing check, not a strategy runner.
const mongoose = require("mongoose");
const { BtcDemoOrderIntentModel } = require("../src/models/BtcDemoOrderIntent");
const { getDeltaDemoAccount, getDeltaDemoBtcExposure, getDeltaDemoProduct,
  getDeltaDemoRecentFills } = require("../src/services/DeltaService");
const { reconcileBtcDemoIntent, requestBtcDemoClose, requestBtcDemoEmergencyClose,
  submitBtcDemoSmoke } = require("../src/services/BtcDemoExecutionService");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = value => process.stdout.write(`${JSON.stringify(value)}\n`);

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--execute-demo-smoke")
    throw new Error("EXPLICIT_DEMO_SMOKE_FLAG_REQUIRED");
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI_REQUIRED");
  await mongoose.connect(process.env.MONGODB_URI);
  await BtcDemoOrderIntentModel.init();
  const [product, account] = await Promise.all([getDeltaDemoProduct(), getDeltaDemoAccount()]);
  const exposure = await getDeltaDemoBtcExposure(product.id);
  const fillsBefore = await getDeltaDemoRecentFills(product.id);
  report({ stage: "PREFLIGHT", account, product, exposure, recentFillCount: fillsBefore.length });
  if (product.id !== 84 || product.symbol !== "BTCUSD" || account.openPositionCount !== 0 ||
      account.activeOrderCount !== 0 || exposure.sizeContracts !== 0 || exposure.activeOrders.length !== 0)
    throw new Error("BTC_SMOKE_EXCHANGE_NOT_FLAT");
  const previous = await BtcDemoOrderIntentModel.findOne({ validationId: "BROKER_SMOKE_V1",
    status: "CLOSED_CONFIRMED", createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }).lean();
  if (previous) throw new Error("BTC_SMOKE_ALREADY_COMPLETED_IN_24H");
  process.env.BTC_DEMO_SMOKE = "ENABLED";
  let intent;
  try {
    intent = await submitBtcDemoSmoke();
    report({ stage: "ENTRY_RECONCILED", clientOrderId: intent.clientOrderId,
      status: intent.status, orderId: intent.orderId, entryFillIds: intent.entryFillIds });
  } catch (error) {
    report({ stage: "ENTRY_ERROR", error: error instanceof Error ? error.message : String(error) });
    intent = await BtcDemoOrderIntentModel.findOne({ activeSlot: "BTCUSD:DELTA_DEMO" }).lean();
    if (!intent) throw error;
  }
  for (let attempt = 0; attempt < 10 && intent.status === "ORDER_ACKNOWLEDGED"; attempt++) {
    await delay(1000);
    intent = await reconcileBtcDemoIntent(intent.clientOrderId);
  }
  if (intent.status === "FILLED_PROTECTED") {
    try { intent = await requestBtcDemoClose(intent.clientOrderId); }
    catch (error) { report({ stage: "CLOSE_ERROR", error: error instanceof Error ? error.message : String(error) }); }
  } else if (["ATTENTION", "ORDER_ACKNOWLEDGED"].includes(intent.status)) {
    const live = await getDeltaDemoBtcExposure(product.id);
    if (live.sizeContracts !== 0 && !intent.closeClientOrderId) {
      try { intent = await requestBtcDemoEmergencyClose(intent.clientOrderId); }
      catch (error) { report({ stage: "EMERGENCY_CLOSE_ERROR", error: error instanceof Error ? error.message : String(error) }); }
    }
  }
  for (let attempt = 0; attempt < 10 && !["CLOSED_CONFIRMED", "CANCELLED_UNFILLED"].includes(intent.status); attempt++) {
    await delay(1000);
    intent = await reconcileBtcDemoIntent(intent.clientOrderId);
  }
  const [finalAccount, finalExposure, finalFills] = await Promise.all([
    getDeltaDemoAccount(), getDeltaDemoBtcExposure(product.id), getDeltaDemoRecentFills(product.id),
  ]);
  report({ stage: "FINAL", clientOrderId: intent.clientOrderId, status: intent.status,
    attentionReason: intent.attentionReason, orderId: intent.orderId,
    closeClientOrderId: intent.closeClientOrderId, closeOrderId: intent.closeOrderId,
    entryFillIds: intent.entryFillIds, exitFillIds: intent.exitFillIds,
    realizedPnlUsd: intent.realizedPnlUsd, account: finalAccount,
    exposure: finalExposure, recentFillCount: finalFills.length });
  if (intent.status !== "CLOSED_CONFIRMED" || finalExposure.sizeContracts !== 0)
    throw new Error("BTC_SMOKE_NOT_CLOSED_AND_RECONCILED");
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
