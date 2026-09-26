import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import mongoose, { type ClientSession } from "mongoose";
import { executionModels, createExecutionIndexes } from "../../src/db/executionModels";
import { RiskAdmissionService } from "../../src/services/RiskAdmissionService";
import { FillProcessor } from "../../src/services/FillProcessor";
import { OrderManager } from "../../src/services/OrderManager";
import { CloseIntentService } from "../../src/services/CloseIntentService";
import { CloseWorkflowService } from "../../src/services/CloseWorkflowService";
import { PaperBrokerAdapter, type PaperScenario } from "../../src/brokers/PaperBrokerAdapter";
import { RiskControlService } from "../../src/services/RiskControlService";
import { RiskSettlementService } from "../../src/services/RiskSettlementService";
import * as f from "../fixtures";
const uri = process.env.EXECUTION_TEST_MONGO_URI;
if (!uri || !new URL(uri).pathname.startsWith("/phase2a_test_")) throw new Error("isolated real Mongo required");
const connection = mongoose.createConnection(uri), models = executionModels(connection), clock = () => new Date(at);
let at = new Date(f.now);
const deadline = new Date(f.now.getTime() + 10 * 86400000);
const policy = { policyVersion: 1, maxRiskPerEntryMinor: 1000000, maxReservedRiskMinor: 1000000, maxPositionSlots: 10, maxDailyLossMinor: 30000 };
const admission = () => new RiskAdmissionService(connection, f.scope, clock);
const processor = () => new FillProcessor(connection, f.scope, clock);
let ids = 0;
async function tx<T>(work: (session: ClientSession) => Promise<T>) {
  const session = await connection.startSession();
  try { return await session.withTransaction(() => work(session)); } finally { await session.endSession(); }
}
async function configure(changes: Record<string, unknown>) {
  await tx(async session => { const account = await models.TradingAccount.findOne(f.scope).session(session).orFail();
    account.set(changes); await account.save({ session }); });
}
async function seed(id = "1", price = 10000, multi = false) {
  const legs = ["a", ...(multi ? ["b"] : [])].map(legId => ({ legId, contractKey: `NFO:${legId}`, side: "BUY", targetUnits: 10 }));
  await tx(async session => {
    await new models.StrategySignal({ ...f.signal(`s-${id}`), decisionKey: `d-${id}`, expiresAt: deadline }).save({ session });
    await new models.OrderIntent({ ...f.intent(`i-${id}`), signalId: `s-${id}`, deadline, targetLegs: legs,
      entryPlan: { kind: "BUY_OPTION_LIMIT_V1", product: "INTRADAY", validUntil: deadline,
        legs: legs.map(({ legId, contractKey }) => ({ legId, contractKey, instrumentKind: "NSE_OPTION", optionType: "CALL",
          expiry: deadline, qualificationRef: `qualified-${legId}`, lotSizeUnits: 1, tickSizeMinor: 1, limitPriceMinor: price })) } }).save({ session });
    await new models.Position({ ...f.position(`p-${id}`), entryIntentId: `i-${id}`,
      legs: legs.map(l => ({ ...f.position().legs[0], legId: l.legId, contractKey: l.contractKey })),
      closePolicy: { kind: "POSITION_LIMIT_V1", product: "INTRADAY", policyVersion: 1, expiresAt: deadline,
        legLimits: legs.map(l => ({ legId: l.legId, limitPriceMinor: price })) } }).save({ session });
  });
}
async function authorize(id = "1") {
  const result = await admission().authorizeEntry(`i-${id}`); assert.equal(result.status, "AUTHORIZED"); return result;
}
function broker(plan: PaperScenario) {
  return new PaperBrokerAdapter(f.scope, { clock: { now: () => clock().toISOString() }, ids: { nextId: kind => `${kind}-${++ids}` }, scenario: () => plan });
}
async function submit(plan: PaperScenario, id = "1", legId = "a") {
  const child = await models.BrokerOrder.findOne({ intentId: `i-${id}`, legId }).orFail(), paper = broker(plan);
  assert.equal((await new OrderManager(connection, f.scope, paper, clock).submit(child.get("orderId"))).status, "PERSISTED");
  return { paper, orderId: String(child.get("orderId")), trades: await paper.getTrades(f.scope) };
}
async function setup(fills = [{ quantityUnits: 4, priceMinor: 9000 }]) {
  await seed(); await authorize(); return submit({ submission: "ACCEPTED", initialFills: fills });
}
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const [name, model] of Object.entries(models)) result[name] = await model.find().sort({ _id: 1 }).lean();
  return result;
}
async function expectAccount(pending: number, committed: number, slots = 1, committedSlots = 1) {
  const account = await models.TradingAccount.findOne().orFail();
  assert.equal(account.get("reservedMarginMinor"), pending); assert.equal(account.get("reservedExposureMinor"), pending);
  assert.equal(account.get("committedExposureMinor"), committed); assert.equal(account.get("positionSlots"), slots);
  assert.equal(account.get("committedPositionSlots"), committedSlots);
  return account;
}
before(async () => { await connection.asPromise(); });
after(async () => { await connection.close(); });
beforeEach(async () => { ids = 0; at = new Date(f.now); await connection.dropDatabase(); await createExecutionIndexes(connection);
  await tx(session => new models.TradingAccount({ ...f.account(), admissionStatus: "PAPER_READY", entryRiskPolicy: policy }).save({ session })); });


const controls = () => new RiskControlService(connection, f.scope, clock);
const settle = (id = "1") => new RiskSettlementService(connection, f.scope, clock).settleClosedPosition(`p-${id}`);
async function open(id = "1") {
  await seed(id); await authorize(id);
  const r = await submit({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 10, priceMinor: 10000 }] }, id);
  await processor().process(r.trades[0]); return r;
}
async function closeEvidence(id = "1", price = 7000, units = 10) {
  const close = await new CloseIntentService(connection, f.scope, clock).requestClose(`p-${id}`, `close-${id}`);
  const paper = broker({ submission: "ACCEPTED", initialFills: [{ quantityUnits: units, priceMinor: price }] });
  await new OrderManager(connection, f.scope, paper, clock).submit(close.orderIds[0]);
  // Above/below the SELL limit is deliberately supplied as owned broker truth.
  const order = await models.BrokerOrder.findOne({ orderId: close.orderIds[0] }).orFail();
  const retained = await paper.getTrades(f.scope);
  if (!retained.length) throw new Error("test requires executable SELL price");
  return { close, paper, trade: retained[0], order };
}
async function exit(id = "1", price = 7000) {
  // Set the trusted CLOSE limit before creating a close workflow.
  await tx(async session => { const p = await models.Position.findOne({ positionId: `p-${id}` }).session(session).orFail();
    p.set("closePolicy.legLimits", [{ legId: "a", limitPriceMinor: price }]); await p.save({ session }); });
  const r = await closeEvidence(id, price); await processor().process(r.trade);
  assert.equal((await new CloseWorkflowService(connection, f.scope, clock).advance(`p-${id}`)).status, "CLOSED"); return r;
}
async function expectPnl(total: number, day = total) {
  const a = await models.TradingAccount.findOne().orFail();
  assert.equal(a.get("realizedPnlMinor"), total); assert.equal(a.get("dailyRealizedPnlMinor"), day); return a;
}
for (const [price, pnl] of [[12000, 20000], [7000, -30000]]) test(`real close at ${price} derives signed P&L ${pnl}`, async () => {
  await open(); await exit("1", price); await expectPnl(pnl);
  const p = await models.Position.findOne().orFail(); assert.equal(p.get("realizedPnlMinor"), pnl); assert.equal(p.get("legs.0.realizedPnlMinor"), pnl);
  await expectAccount(0, 100000); // Realization is not settlement.
});
test("real multiple Positions aggregate signed daily results and concurrent closes lose no P&L", async () => {
  await open(); await open("2");
  const a = await closeEvidence("1", 10000), b = await closeEvidence("2", 11000);
  await Promise.all([processor().process({ ...a.trade, priceMinor: 6000 }), processor().process(b.trade)]);
  await expectPnl(-30000); assert.equal(await models.Fill.countDocuments(), 4);
});
test("real partial CLOSE and replay derive cumulative cost once", async () => {
  await open(); const r = await closeEvidence("1", 10000, 4);
  const first = { ...r.trade, priceMinor: 7000 }; await processor().process(first); await expectPnl(-12000);
  const before = await snapshot(); assert.equal((await processor().process(first)).status, "DUPLICATE"); assert.deepEqual(await snapshot(), before);
  const second = { ...first, brokerTradeKey: "remaining-close", quantityUnits: 6 };
  await processor().process(second); await expectPnl(-30000);
  assert.equal((await models.Position.findOne().orFail()).get("legs.0.exitFilledUnits"), 10);
});
for (const [price, allowed] of [[7001, true], [7000, false], [6999, false]] as const)
test(`real daily-loss boundary close price ${price} allows ENTRY=${allowed}`, async () => {
  await open(); await exit("1", price); await seed("2"); const result = await admission().authorizeEntry("i-2");
  assert.equal(result.status, allowed ? "AUTHORIZED" : "REJECTED"); if (!allowed) { assert.equal(result.status, "REJECTED"); assert.equal(result.reason, "DAILY_LOSS_LIMIT_EXCEEDED"); }
});
test("real CLOSE stays usable after daily loss is reached", async () => {
  await open(); await open("2"); await exit(); await exit("2", 11000); await expectPnl(-20000);
});
test("real kill switch persists across a new connection and blocks ENTRY while CLOSE remains allowed", async () => {
  await open(); await controls().setKillSwitch("stop", true, "manual stop");
  const other = await mongoose.createConnection(uri!).asPromise();
  try { await seed("2"); const result = await new RiskAdmissionService(other, f.scope, clock).authorizeEntry("i-2"); assert.equal(result.status, "REJECTED"); assert.equal(result.reason, "KILL_SWITCH_ACTIVE"); }
  finally { await other.close(); }
  await exit("1", 12000); await expectPnl(20000);
  await controls().setKillSwitch("resume", false, "manual resume"); assert.equal((await admission().authorizeEntry("i-2")).status, "AUTHORIZED");
});
test("real kill command replay is idempotent and conflicting command fails closed", async () => {
  await controls().setKillSwitch("k", true, "reason"); const before = await snapshot();
  assert.equal((await controls().setKillSwitch("k", true, "reason")).replay, true); assert.deepEqual(await snapshot(), before);
  await assert.rejects(controls().setKillSwitch("k", false, "reason"), /KILL_COMMAND_CONFLICT/);
  await assert.rejects(configure({ killSwitchEnabled: false }), /AUDITED_KILL_SERVICE_REQUIRED/);
});
test("real initial ENTRY dispatch is blocked when kill activates after admission", async () => {
  await seed(); await authorize(); await controls().setKillSwitch("k", true, "stop");
  const before = await snapshot(); await assert.rejects(submit({ submission: "ACCEPTED" }), /KILL_SWITCH_ACTIVE/); assert.deepEqual(await snapshot(), before);
});
test("real post-dispatch ENTRY truth survives kill, halt and reduced policy", async () => {
  await seed(); await authorize(); const r = await submit({ submission: "AMBIGUOUS", initialFills: [{ quantityUnits: 4, priceMinor: 9000 }] });
  await controls().setKillSwitch("k", true, "stop"); await configure({ admissionStatus: "HALTED", policyVersion: 2,
    entryRiskPolicy: { ...policy, policyVersion: 2, maxDailyLossMinor: 1, maxReservedRiskMinor: 1 } });
  assert.equal((await processor().process(r.trades[0])).status, "APPLIED"); await expectAccount(60000, 36000);
});
for (const enabled of [true, false]) test(`real kill enabled=${enabled} event failure rolls back command and sequence`, async () => {
  if (!enabled) await controls().setKillSwitch("initial", true, "stop");
  const before = await snapshot(), original = models.TradingEvent.prototype.save;
  models.TradingEvent.prototype.save = function () { return Promise.reject(new Error("injected-control-event")); };
  try { await assert.rejects(controls().setKillSwitch("change", enabled, "reason"), /injected-control-event/); }
  finally { models.TradingEvent.prototype.save = original; }
  assert.deepEqual(await snapshot(), before); await controls().setKillSwitch("change", enabled, "reason");
});
test("real proven CLOSED settlement releases only owned exposure/slot and retains realized loss", async () => {
  await open(); await open("2"); await exit(); const initial: Record<string, any> = (await models.RiskReservation.findOne({ intentId: "i-1" }).orFail()).toObject();
  assert.equal((await settle()).replay, false); await expectAccount(0, 100000, 1, 1); await expectPnl(-30000);
  const hold = await models.RiskReservation.findOne({ intentId: "i-1" }).orFail(); assert.equal(hold.get("state"), "RELEASED");
  assert.equal(hold.get("initialExposureMinor"), initial.initialExposureMinor); assert.deepEqual(hold.get("entryProgress"), initial.entryProgress);
  const before = await snapshot(); assert.equal((await settle()).replay, true); assert.deepEqual(await snapshot(), before);
  await assert.rejects(tx(async session => { const h = await models.RiskReservation.findOne({ intentId: "i-1" }).session(session).orFail(); h.set("state", "HELD"); await h.save({ session }); }));
});
test("real settled capacity permits new ENTRY while loss history remains counted", async () => {
  await configure({ entryRiskPolicy: { ...policy, maxPositionSlots: 1 } }); await open(); await exit("1", 12000); await settle(); await seed("2"); await authorize("2");
  await expectAccount(100000, 0, 1, 0); await expectPnl(20000);
});
test("real same Position settlement writers release once with one event", async () => {
  await open(); await exit(); const results = await Promise.all([settle(), settle()]);
  assert.deepEqual(results.map(r => r.replay).sort(), [false, true]); await expectAccount(0, 0, 0, 0);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "ENTRY_RISK_SETTLED" }), 1);
});
test("real different Position settlements both release their own risk", async () => {
  await open(); await open("2"); await exit(); await exit("2", 11000); await Promise.all([settle(), settle("2")]);
  await expectAccount(0, 0, 0, 0); await expectPnl(-20000); assert.equal(await models.TradingEvent.countDocuments({ eventType: "ENTRY_RISK_SETTLED" }), 2);
});
for (const knowledge of ["UNKNOWN", "RECONCILIATION_REQUIRED"]) test(`real flat CLOSED with ${knowledge} relevant order cannot settle`, async () => {
  await open(); await exit(); await connection.db!.collection("execution_orders").updateOne({ intentId: "i-1" }, { $set: { knowledge } });
  const before = await snapshot(); await assert.rejects(settle()); assert.deepEqual(await snapshot(), before); await expectAccount(0, 100000);
});
test("real flat CLOSED with unresolved RECOVERY intent cannot settle", async () => {
  await open(); await exit(); await tx(session => new models.OrderIntent({ ...f.intent("recovery"), purpose: "RECOVERY", positionId: "p-1", targetLegs: [{ legId: "a", contractKey: "NFO:a", side: "SELL", targetUnits: 10 }] }).save({ session }));
  const before = await snapshot(); await assert.rejects(settle()); assert.deepEqual(await snapshot(), before);
});
test("real partial ENTRY remainder blocks CLOSE and settlement without releasing pending risk", async () => {
  const r = await setup(); await processor().process(r.trades[0]);
  await assert.rejects(new CloseIntentService(connection, f.scope, clock).requestClose("p-1", "close"));
  const before = await snapshot(); await assert.rejects(settle()); assert.deepEqual(await snapshot(), before); await expectAccount(60000, 36000);
});
for (const submission of ["REJECTED", "AMBIGUOUS"] as const) test(`real zero-fill ${submission} remains held without completed terminal workflow`, async () => {
  await seed(); await authorize(); await submit({ submission }); const before = await snapshot();
  await assert.rejects(settle()); assert.deepEqual(await snapshot(), before); await expectAccount(100000, 0, 1, 0);
});
for (const entity of ["RiskReservation", "TradingAccount", "TradingEvent"] as const)
test(`real settlement ${entity} failure rolls back release and retry settles exactly once`, async () => {
  await open(); await exit(); const before = await snapshot(), original = models[entity].prototype.save;
  models[entity].prototype.save = function () { return Promise.reject(new Error("injected-settlement")); };
  try { await assert.rejects(settle(), /injected-settlement/); } finally { models[entity].prototype.save = original; }
  assert.deepEqual(await snapshot(), before); await settle(); await expectAccount(0, 0, 0, 0); const after = await snapshot(); await settle(); assert.deepEqual(await snapshot(), after);
});
test("real realized-P&L audit failure rolls back Fill, Position and account then retries once", async () => {
  await open(); const r = await closeEvidence("1", 10000), before = await snapshot(), original = models.TradingEvent.prototype.save;
  models.TradingEvent.prototype.save = function (...args: unknown[]) {
    if (this.get("eventType") === "DAILY_PNL_UPDATED") return Promise.reject(new Error("injected-pnl")); return original.apply(this, args);
  };
  const trade = { ...r.trade, priceMinor: 7000 };
  try { await assert.rejects(processor().process(trade), /injected-pnl/); } finally { models.TradingEvent.prototype.save = original; }
  assert.deepEqual(await snapshot(), before); await processor().process(trade); await expectPnl(-30000);
  const after = await snapshot(); await processor().process(trade); assert.deepEqual(await snapshot(), after);
});
test("real trading-day rollover retains history/risk and never clears kill", async () => {
  await open(); await exit(); await controls().setKillSwitch("k", true, "stop"); at = new Date(f.now.getTime() + 86400000);
  assert.equal((await controls().advanceTradingDay()).changed, true); await expectPnl(-30000, 0); await expectAccount(0, 100000);
  const a = await models.TradingAccount.findOne().orFail(); assert.equal(a.get("killSwitchEnabled"), true);
  assert.deepEqual(a.get("realizedPnlDays"), [{ tradingDay: "2026-09-11", realizedPnlMinor: -30000 }]);
  const before = await snapshot(); assert.equal((await controls().advanceTradingDay()).changed, false); assert.deepEqual(await snapshot(), before);
  await controls().setKillSwitch("resume", false, "resume"); await seed("2"); await authorize("2");
  at = new Date(f.now); await assert.rejects(controls().advanceTradingDay(), /TRADING_DAY_REGRESSION/);
});
test("real new-day admission lazily rolls only daily P&L", async () => {
  await open(); await exit(); at = new Date(f.now.getTime() + 86400000); await seed("2"); await authorize("2");
  await expectPnl(-30000, 0); await expectAccount(100000, 100000, 2, 1);
  assert.equal(await models.TradingEvent.countDocuments({ eventType: "TRADING_DAY_ADVANCED" }), 1);
});
for (const missing of ["calendar", "daily-policy"]) test(`real ${missing} missing fails new ENTRY closed`, async () => {
  await seed(); if (missing === "calendar") await connection.db!.collection("execution_accounts").updateOne(f.scope, { $unset: { riskTradingCalendar: "" } });
  else await configure({ entryRiskPolicy: { policyVersion: 1, maxRiskPerEntryMinor: 1000000, maxReservedRiskMinor: 1000000, maxPositionSlots: 10 } });
  const before = await snapshot(); const result = await admission().authorizeEntry("i-1");
  assert.equal(result.status, "REJECTED"); assert.equal(result.reason, missing === "calendar" ? "TRADING_DAY_CONFIG_REQUIRED" : "DAILY_LOSS_POLICY_REQUIRED"); assert.deepEqual(await snapshot(), before);
});
for (const trigger of ["kill", "loss"]) test(`real conflicting ${trigger} commits before admission resumes and forces rejection`, async () => {
  let trade: Awaited<ReturnType<typeof closeEvidence>>["trade"] | undefined;
  if (trigger === "loss") { await open(); trade = (await closeEvidence("1", 10000)).trade; }
  await seed("2"); let release!: () => void, reached!: () => void, once = false;
  const gate = new Promise<void>(r => { release = r; }), paused = new Promise<void>(r => { reached = r; }), original = models.TradingAccount.prototype.save;
  models.TradingAccount.prototype.save = async function (...args: unknown[]) {
    if (!once && this.get("reservedExposureMinor") === 100000) { once = true; reached(); await gate; }
    return original.apply(this, args);
  };
  const attempt = admission().authorizeEntry("i-2");
  try {
    await Promise.race([paused, attempt.then(() => { throw new Error("admission did not pause"); })]);
    if (trigger === "kill") await controls().setKillSwitch("k", true, "stop"); else await processor().process({ ...trade!, priceMinor: 7000 });
  } finally { release(); models.TradingAccount.prototype.save = original; }
  const result = await attempt; assert.equal(result.status, "REJECTED");
  assert.equal(result.reason, trigger === "kill" ? "KILL_SWITCH_ACTIVE" : "DAILY_LOSS_LIMIT_EXCEEDED");
  assert.equal(await models.RiskReservation.countDocuments({ intentId: "i-2" }), 0);
});

for (const reversed of [false, true]) test(`real cross-day CLOSE delivery reversed=${reversed} preserves historical daily P&L`, async () => {
  await open(); const r = await closeEvidence("1", 10000, 4);
  const first = { ...r.trade, priceMinor: 9000 };
  at = new Date(f.now.getTime() + 86400000);
  const second = { ...r.trade, brokerTradeKey: "day-two-close", quantityUnits: 6, priceMinor: 7000, executedAt: at.toISOString() };
  for (const trade of reversed ? [second, first] : [first, second]) await processor().process(trade);
  const a = await expectPnl(-22000, -18000);
  assert.equal(a.get("dailyTradingDay"), "2026-09-12");
  assert.deepEqual(a.get("realizedPnlDays"), [{ tradingDay: "2026-09-11", realizedPnlMinor: -4000 }, { tradingDay: "2026-09-12", realizedPnlMinor: -18000 }]);
  assert.equal((await models.Position.findOne().orFail()).get("legs.0.exitFilledUnits"), 10);
  assert.equal((await models.BrokerOrder.findOne({ orderId: r.close.orderIds[0] }).orFail()).get("filledUnits"), 10);
});
test("real contradictory closure references cannot release risk", async () => {
  await open(); await exit();
  await connection.db!.collection("execution_positions").updateOne({ positionId: "p-1" }, { $set: { closureEvidenceRefs: ["unowned-fill"] } });
  const before = await snapshot(); await assert.rejects(settle(), /TERMINAL_RISK_PROOF_REQUIRED/); assert.deepEqual(await snapshot(), before);
});
test("real absent settlement audit cannot create new admission capacity", async () => {
  await open(); await exit("1", 12000); await settle(); await seed("2");
  await connection.db!.collection("execution_events").deleteOne({ eventType: "ENTRY_RISK_SETTLED" });
  const before = await snapshot(); const result = await admission().authorizeEntry("i-2");
  assert.equal(result.status, "REJECTED"); assert.equal(result.reason, "RISK_PROJECTION_MISMATCH"); assert.deepEqual(await snapshot(), before);
});
test("real unexplained daily P&L drift cannot bypass the loss gate", async () => {
  await open(); await exit(); await seed("2"); await configure({ dailyRealizedPnlMinor: 0 });
  const before = await snapshot(), result = await admission().authorizeEntry("i-2");
  assert.equal(result.status, "REJECTED"); assert.equal(result.reason, "RISK_PROJECTION_MISMATCH"); assert.deepEqual(await snapshot(), before);
});
test("real direct day mutation cannot skip the audited rollover operation", async () => {
  const before = await snapshot(); await assert.rejects(configure({ dailyTradingDay: "2026-09-12" }), /AUDITED_TRADING_DAY_SERVICE_REQUIRED/);
  await assert.rejects(configure({ dailyTradingDay: "2026-09-10" }), /TRADING_DAY_REGRESSION/); assert.deepEqual(await snapshot(), before);
});
