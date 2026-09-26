import { test } from "node:test";
import assert from "node:assert/strict";
import { compareReconciliation, reconciliationConfigSchema } from "../../src/domain/reconciliation";
import { brokerSnapshot, ledger, reconciliationTime, type SnapshotOptions } from "../reconciliationFixtures";
import * as f from "../fixtures";
const compare = async (options: SnapshotOptions = {}, internal = ledger()) => compareReconciliation(f.scope.accountId, "AB1234", await brokerSnapshot(options), internal, options.time ?? reconciliationTime);
const has = (result: Awaited<ReturnType<typeof compare>>, code: string) => assert.ok(result.discrepancies.some(d => d.code === code), JSON.stringify(result));
test("reconciliation exact partial order, trade and Fill-derived position match", async () => { assert.equal((await compare()).classification, "MATCHED"); });
test("reconciliation working unfilled order matches zero fills", async () => { assert.equal((await compare({ units: 0 }, ledger(0))).classification, "MATCHED"); });
test("reconciliation full execution matches", async () => { assert.equal((await compare({ units: 10 }, ledger(10))).classification, "MATCHED"); });
test("reconciliation requested quantity mismatch", async () => { has(await compare({ order: { quantity: 11 } }), "ORDER_QUANTITY_MISMATCH"); });
test("reconciliation unknown broker status stays unresolved", async () => { has(await compare({ order: { status: "FUTURE_STATUS" } }), "UNKNOWN_BROKER_STATUS"); });
test("reconciliation missing internal Fill preserves broker trade", async () => { const l = ledger(); l.fills = []; l.links = l.links.slice(0, 1); has(await compare({}, l), "BROKER_TRADE_MISSING_INTERNAL_FILL"); });
test("reconciliation conflicting trade economics", async () => { has(await compare({ trade: { average_price: 9.005 } }), "TRADE_ECONOMICS_CONFLICT"); });
test("reconciliation larger broker position", async () => { has(await compare({ position: { quantity: 7 } }), "POSITION_QUANTITY_MISMATCH"); });
test("reconciliation unlinked brokerage activity is outside reference scope", async () => { assert.equal((await compare({}, { orders: [], fills: [], positions: [], links: [] })).classification, "MATCHED"); });
test("reconciliation empty AVAILABLE positions is flat evidence", async () => { has(await compare({ positions: false }), "POSITION_QUANTITY_MISMATCH"); });
test("reconciliation unavailable positions never means flat", async () => { const r = await compare({ fail: "/portfolio/positions" }); assert.equal(r.classification, "INCOMPLETE"); assert.ok(!r.discrepancies.some(d => d.code === "POSITION_QUANTITY_MISMATCH")); });
test("reconciliation partial trades blocks match", async () => { assert.equal((await compare({ fail: "/trades" })).classification, "INCOMPLETE"); });
test("reconciliation account mismatch rejects", async () => { await assert.rejects(compare({ account: "OTHER" }), /BROKER_ACCOUNT_MISMATCH/); });
test("reconciliation deterministic replay", async () => { assert.deepEqual(await compare(), await compare()); });
test("reconciliation prior-day missing Fill is unknown history, not false missing trade", async () => { const l = ledger(); l.fills[0].executedAt = new Date("2026-09-10T04:00:00Z"); const r = await compare({ trades: false }, l); assert.equal(r.classification, "INCOMPLETE"); has(r, "HISTORICAL_EVIDENCE_UNAVAILABLE"); assert.ok(!r.discrepancies.some(d => d.code === "INTERNAL_FILL_NOT_CONFIRMED")); });
test("reconciliation cancellation counters cannot conceal contradictory evidence", async () => { has(await compare({ order: { cancelled_quantity: 8 } }), "ORDER_QUANTITY_MISMATCH"); });
test("reconciliation same symbol different product cannot net exposure", async () => { has(await compare({ position: { product: "NRML" } }), "POSITION_QUANTITY_MISMATCH"); });
test("reconciliation same symbol different instrument token cannot net exposure", async () => { has(await compare({ position: { instrument_token: 999 } }), "POSITION_QUANTITY_MISMATCH"); });
test("reconciliation order cumulative quantity never manufactures missing trade units", async () => { has(await compare({ order: { filled_quantity: 10, pending_quantity: 0, status: "COMPLETE" } }), "ORDER_TRADE_QUANTITY_MISMATCH"); });
test("reconciliation UNKNOWN internal knowledge is retained even with exact broker facts", async () => { const l = ledger(); l.orders[0].knowledge = "UNKNOWN"; assert.equal((await compare({}, l)).classification, "RECONCILIATION_REQUIRED"); });
test("reconciliation future and prior-day retrieval timestamps cannot match", async () => {
  for (const time of [new Date("2026-09-10T04:00:00Z"), new Date("2026-09-12T04:00:00Z")]) {
    const r = compareReconciliation(f.scope.accountId, "AB1234", await brokerSnapshot({ time }), ledger(), reconciliationTime); assert.equal(r.classification, "INCOMPLETE");
  }
});
test("reconciliation cannot use a fabricated position projection", async () => { const l = ledger(); l.positions[0].legs[0].entryFilledUnits = 8; has(await compare({}, l), "INTERNAL_POSITION_PROJECTION_MISMATCH"); });

test("reference-only unlinked PAPER orders, fills and positions need no Kite counterparts", async () => {
  const l = ledger(); l.links = []; assert.equal((await compare({orders:false,trades:false,positions:false},l)).classification,"MATCHED");
});
test("reference-only linked quantities still conflict", async () => { has(await compare({trade:{quantity:3}}),"TRADE_ECONOMICS_CONFLICT"); });
test("reference-only config is explicit and broker-backed execution stays disabled", () => {
  assert.ok(reconciliationConfigSchema.safeParse({kind:"PAPER_KITE_SHADOW_V1",scope:"REFERENCE_ONLY",brokerAccountId:"AB1234"}).success);
  for (const scope of [undefined,"BROKER_BACKED_EXECUTION","LIVE"]) assert.equal(reconciliationConfigSchema.safeParse({kind:"PAPER_KITE_SHADOW_V1",scope,brokerAccountId:"AB1234"}).success,false);
});

test("reference order linkage alone does not claim the entire brokerage net position", async () => {
  const l=ledger(); const link=l.links[0].link; if(link.kind!=="ORDER") throw new Error("fixture"); delete link.positionScope;
  assert.equal((await compare({position:{quantity:54}},l)).classification,"MATCHED");
});
