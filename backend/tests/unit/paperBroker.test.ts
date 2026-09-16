import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brokerOrderRequestSchema, type BrokerAdapter, type BrokerOrderRequest, type BrokerOrderReference, type BrokerOrderObservation } from "../../src/brokers/BrokerAdapter";
import { PaperBrokerAdapter, type PaperScenario } from "../../src/brokers/PaperBrokerAdapter";
import { transitionOrder, type OrderEvent } from "../../src/domain/OrderStateMachine";
import * as foundation from "../fixtures";

const scope = { accountId: "PAPER:test", executionMode: "PAPER" } as const;
const request: BrokerOrderRequest = { ...scope, orderId: "order-1", claimId: "claim-1", intentId: "intent-1",
  positionId: "position-1", legId: "leg-1", contractKey: "NFO:test-contract", side: "BUY", quantityUnits: 130,
  orderType: "LIMIT", limitPriceMinor: 10000, product: "INTRADAY", correlationTag: "correlation-1" };
const lookup = { ...scope, orderId: request.orderId };
const fill = (quantityUnits: number) => ({ quantityUnits, priceMinor: 9900 });
const fillStep = (quantityUnits: number) => ({ kind: "FILL" as const, ...fill(quantityUnits) });
function broker(plan: PaperScenario = { submission: "ACCEPTED" }) {
  let sequence = 0;
  return new PaperBrokerAdapter(scope, {
    clock: { now: () => "2026-09-12T04:00:00.000Z" },
    ids: { nextId: kind => `${kind}-${++sequence}` }, scenario: () => plan,
  });
}
async function ref(adapter: BrokerAdapter): Promise<BrokerOrderReference> {
  const order = await adapter.getOrder(lookup); assert.ok(order);
  return { ...scope, brokerNamespace: order.brokerNamespace, brokerOrderId: order.brokerOrderId };
}
test("paper submission full fill produces owned immutable trade evidence", async () => {
  const adapter: BrokerAdapter = broker({ submission: "ACCEPTED", initialFills: [fill(130)] });
  const outcome = await adapter.submitOrder(request);
  assert.equal(outcome.kind, "ACCEPTED");
  if (outcome.kind !== "ACCEPTED") assert.fail("Expected acceptance");
  assert.equal(outcome.order.state, "FILLED"); assert.equal(outcome.order.filledUnits, 130);
  assert.equal(outcome.order.remainingUnits, 0);
  const [trade] = await adapter.getTrades(scope);
  for (const key of ["accountId", "executionMode", "orderId", "positionId", "intentId", "legId", "contractKey", "side"] as const)
    assert.equal(trade[key], request[key]);
  assert.equal(trade.priceMinor, 9900); assert.equal(trade.quantityUnits, 130);
  assert.equal(trade.brokerOrderId, outcome.order.brokerOrderId);
  assert.ok(Object.isFrozen(trade)); assert.ok(Object.isFrozen(trade.evidence));
});
test("paper accepted unfilled order remains unchanged by repeated reads", async () => {
  const adapter = broker({ submission: "ACCEPTED", steps: [fillStep(130)] });
  await adapter.submitOrder(request);
  const first = await adapter.getOrder(lookup);
  assert.equal(first?.state, "OPEN"); assert.equal(first?.filledUnits, 0);
  assert.deepEqual(await adapter.getOrder(lookup), first);
  assert.deepEqual(await adapter.getTrades(scope), []);
});
test("explicit rejection creates no simulated order or trade", async () => {
  const adapter = broker({ submission: "REJECTED" });
  const result = await adapter.submitOrder(request);
  assert.equal(result.kind, "REJECTED");
  assert.deepEqual(await adapter.getOrders(scope), []); assert.deepEqual(await adapter.getTrades(scope), []);
  assert.deepEqual(await adapter.submitOrder(request), result);
});
test("partial fill is a first-class accepted observation", async () => {
  const adapter = broker({ submission: "ACCEPTED", initialFills: [fill(40)] });
  await adapter.submitOrder(request);
  const order = await adapter.getOrder(lookup);
  assert.equal(order?.state, "PARTIALLY_FILLED"); assert.equal(order?.filledUnits, 40); assert.equal(order?.remainingUnits, 90);
});
test("ambiguous submission retains accepted order discoverable by internal and broker lookup", async () => {
  const adapter = broker({ submission: "AMBIGUOUS" });
  const result = await adapter.submitOrder(request);
  assert.equal(result.kind, "AMBIGUOUS");
  const order = await adapter.getOrder(lookup); assert.equal(order?.state, "OPEN");
  assert.deepEqual(await adapter.getOrder(await ref(adapter)), order);
  assert.deepEqual(await adapter.getOrders(scope), [order]);
  assert.deepEqual(await adapter.submitOrder(request), result);
  assert.equal((await adapter.getOrders(scope)).length, 1);
});
test("ambiguous acceptance may already have fills without becoming a rejection", async () => {
  const adapter = broker({ submission: "AMBIGUOUS", initialFills: [fill(130)] });
  assert.equal((await adapter.submitOrder(request)).kind, "AMBIGUOUS");
  assert.equal((await adapter.getOrder(lookup))?.state, "FILLED");
  assert.equal((await adapter.getTrades(scope)).length, 1);
});
test("identical concurrent submissions replay original receipt without duplicate orders/trades", async () => {
  const adapter = broker({ submission: "ACCEPTED", initialFills: [fill(130)] });
  const results = await Promise.all([adapter.submitOrder(request), adapter.submitOrder({ ...request })]);
  assert.deepEqual(results[0], results[1]);
  assert.equal((await adapter.getOrders(scope)).length, 1); assert.equal((await adapter.getTrades(scope)).length, 1);
});
test("conflicting economics or ownership under one claim is rejected", async () => {
  const adapter = broker(); await adapter.submitOrder(request);
  for (const mutation of [{ quantityUnits: 129 }, { positionId: "position-2" }, { intentId: "intent-2" }, { contractKey: "other" }]) {
    const result = await adapter.submitOrder({ ...request, ...mutation });
    assert.equal(result.kind, "REJECTED");
    if (result.kind === "REJECTED") assert.equal(result.reason, "DUPLICATE_CONFLICT");
  }
  assert.equal((await adapter.getOrders(scope)).length, 1);
});
test("new claim cannot duplicate an existing internal physical order", async () => {
  const adapter = broker(); await adapter.submitOrder(request);
  assert.equal((await adapter.submitOrder({ ...request, claimId: "new-claim" })).kind, "REJECTED");
  assert.equal((await adapter.getOrders(scope)).length, 1);
});
test("130-unit order advances 0 → 40 → 65 → 130 with unique trade IDs", async () => {
  const adapter = broker({ submission: "ACCEPTED", steps: [fillStep(40), fillStep(25), fillStep(65)] });
  await adapter.submitOrder(request);
  const cumulative = [(await adapter.getOrder(lookup))!.filledUnits];
  const versions: number[] = [];
  for (let i = 0; i < 3; i++) { const order = await adapter.advance(lookup); cumulative.push(order.filledUnits); versions.push(order.observationVersion); }
  assert.deepEqual(cumulative, [0, 40, 65, 130]); assert.deepEqual(versions, [2, 3, 4]);
  const trades = await adapter.getTrades(scope);
  assert.deepEqual(trades.map(t => t.quantityUnits), [40, 25, 65]);
  assert.equal(new Set(trades.map(t => t.brokerTradeKey)).size, 3);
  assert.ok(trades.every(t => !("kind" in t)));
  assert.equal((await adapter.advance(lookup)).filledUnits, 130);
});
test("scenario overfill fails before publishing any order or trades", async () => {
  const adapter = broker({ submission: "ACCEPTED", initialFills: [fill(40)], steps: [fillStep(91)] });
  await assert.rejects(adapter.submitOrder(request), /SCENARIO_QUANTITY_OVERFLOW/);
  assert.deepEqual(await adapter.getOrders(scope), []); assert.deepEqual(await adapter.getTrades(scope), []);
});
test("quantity accumulation remains exact at the safe integer boundary", async () => {
  const adapter = broker({ submission: "ACCEPTED", initialFills: [fill(Number.MAX_SAFE_INTEGER - 1)], steps: [fillStep(1)] });
  await adapter.submitOrder({ ...request, quantityUnits: Number.MAX_SAFE_INTEGER });
  assert.equal((await adapter.advance(lookup)).filledUnits, Number.MAX_SAFE_INTEGER);
  const overflow = broker({ submission: "ACCEPTED", initialFills: [fill(Number.MAX_SAFE_INTEGER)], steps: [fillStep(1)] });
  await assert.rejects(overflow.submitOrder({ ...request, quantityUnits: Number.MAX_SAFE_INTEGER }), /OVERFLOW/);
});
test("cancel acceptance is a request; only a subsequent event cancels unfilled order", async () => {
  const adapter = broker({ submission: "ACCEPTED", steps: [{ kind: "CONFIRM_CANCEL" }] });
  await adapter.submitOrder(request);
  await assert.rejects(adapter.advance(lookup), /CANCEL_NOT_REQUESTED/);
  assert.equal((await adapter.cancelOrder(await ref(adapter))).kind, "ACCEPTED");
  const pending = await adapter.getOrder(lookup);
  assert.equal(pending?.state, "OPEN"); assert.equal(pending?.cancellation, "REQUESTED");
  const cancelled = await adapter.advance(lookup);
  assert.equal(cancelled.state, "CANCELLED"); assert.equal(cancelled.cancellation, "CONFIRMED");
  assert.equal(cancelled.filledUnits, 0); assert.equal(cancelled.remainingUnits, 130);
});
test("cancel after partial fill preserves all trade evidence and unfilled remainder", async () => {
  const adapter = broker({ submission: "ACCEPTED", initialFills: [fill(40)], steps: [{ kind: "CONFIRM_CANCEL" }] });
  await adapter.submitOrder(request); const trades = await adapter.getTrades(scope);
  await adapter.cancelOrder(await ref(adapter)); const result = await adapter.advance(lookup);
  assert.equal(result.state, "CANCELLED"); assert.equal(result.filledUnits, 40); assert.equal(result.remainingUnits, 90);
  assert.deepEqual(await adapter.getTrades(scope), trades);
});
test("duplicate cancellation is idempotent before and after confirmation", async () => {
  const adapter = broker({ submission: "ACCEPTED", steps: [{ kind: "CONFIRM_CANCEL" }] });
  await adapter.submitOrder(request); const reference = await ref(adapter);
  const first = await adapter.cancelOrder(reference); const before = await adapter.getOrder(lookup);
  assert.deepEqual(await adapter.cancelOrder(reference), first); assert.deepEqual(await adapter.getOrder(lookup), before);
  await adapter.advance(lookup);
  const replay = await adapter.cancelOrder(reference);
  assert.deepEqual(replay, first); assert.ok(Object.isFrozen(replay.evidence));
  assert.equal((await adapter.getOrder(lookup))?.state, "CANCELLED");
});
test("full fill wins cancellation race without losing executions", async () => {
  const adapter = broker({ submission: "ACCEPTED", initialFills: [fill(40)], steps: [fillStep(90), { kind: "CONFIRM_CANCEL" }] });
  await adapter.submitOrder(request); await adapter.cancelOrder(await ref(adapter));
  assert.equal((await adapter.advance(lookup)).state, "FILLED");
  const terminal = await adapter.advance(lookup);
  assert.equal(terminal.state, "FILLED"); assert.equal(terminal.filledUnits, 130);
  assert.deepEqual((await adapter.getTrades(scope)).map(t => t.quantityUnits), [40, 90]);
});
test("partial fill during cancellation is retained on confirmed cancellation", async () => {
  const adapter = broker({ submission: "ACCEPTED", steps: [fillStep(25), { kind: "CONFIRM_CANCEL" }] });
  await adapter.submitOrder(request); await adapter.cancelOrder(await ref(adapter));
  await adapter.advance(lookup); const terminal = await adapter.advance(lookup);
  assert.equal(terminal.state, "CANCELLED"); assert.equal(terminal.filledUnits, 25); assert.equal(terminal.remainingUnits, 105);
});
test("ambiguous cancellation is retained and resolved by later observation", async () => {
  const adapter = broker({ submission: "ACCEPTED", cancellation: "AMBIGUOUS", steps: [{ kind: "CONFIRM_CANCEL" }] });
  await adapter.submitOrder(request); const reference = await ref(adapter);
  const result = await adapter.cancelOrder(reference); assert.equal(result.kind, "AMBIGUOUS");
  assert.deepEqual(await adapter.cancelOrder(reference), result);
  assert.equal((await adapter.getOrder(lookup))?.state, "OPEN");
  assert.equal((await adapter.advance(lookup)).state, "CANCELLED");
});
test("cancellation rejection and terminal-order rejection do not alter fills", async () => {
  const adapter = broker({ submission: "ACCEPTED", cancellation: "REJECTED" });
  await adapter.submitOrder(request); const before = await adapter.getOrder(lookup);
  assert.equal((await adapter.cancelOrder(await ref(adapter))).kind, "REJECTED");
  assert.deepEqual(await adapter.getOrder(lookup), before);
  const full = broker({ submission: "ACCEPTED", initialFills: [fill(130)] });
  await full.submitOrder(request); assert.equal((await full.cancelOrder(await ref(full))).kind, "REJECTED");
  assert.equal((await full.getOrder(lookup))?.filledUnits, 130);
});
test("confirmed cancellation prevents future scripted fills", async () => {
  const adapter = broker({ submission: "ACCEPTED", steps: [{ kind: "CONFIRM_CANCEL" }, fillStep(130)] });
  await adapter.submitOrder(request); await adapter.cancelOrder(await ref(adapter)); await adapter.advance(lookup);
  await assert.rejects(adapter.advance(lookup), /ORDER_NOT_FILLABLE/);
  assert.deepEqual(await adapter.getTrades(scope), []);
});
test("delayed acknowledgement is advanced explicitly with stable read observations", async () => {
  const adapter = broker({ submission: "ACCEPTED", delayedAcknowledgement: true,
    steps: [{ kind: "ACKNOWLEDGE" }, fillStep(130)] });
  await adapter.submitOrder(request); assert.equal((await adapter.getOrder(lookup))?.state, "PENDING_ACK");
  assert.equal((await adapter.getOrders(scope))[0].state, "PENDING_ACK");
  assert.equal((await adapter.advance(lookup)).state, "OPEN"); assert.equal((await adapter.advance(lookup)).state, "FILLED");
});
test("PAPER allowed while LIVE, LEGACY_PAPER and wrong-account submissions fail closed", async () => {
  const adapter = broker();
  for (const other of [{ accountId: "LIVE:test", executionMode: "LIVE" }, { accountId: "LEGACY_PAPER:test", executionMode: "LEGACY_PAPER" },
    { accountId: "PAPER:other", executionMode: "PAPER" }] as const) {
    const result = await adapter.submitOrder({ ...request, ...other }); assert.equal(result.kind, "REJECTED");
  }
  assert.deepEqual(await adapter.getOrders(scope), []);
  assert.equal((await adapter.submitOrder(request)).kind, "ACCEPTED");
});
test("cross-account/mode/namespace lookup and cancellation cannot expose or alter evidence", async () => {
  const adapter = broker(); await adapter.submitOrder(request); const reference = await ref(adapter);
  const before = await adapter.getOrder(lookup);
  for (const other of [{ accountId: "PAPER:other", executionMode: "PAPER" }, { accountId: "LIVE:test", executionMode: "LIVE" },
    { accountId: "PAPER:test", executionMode: "LIVE" }] as const) {
    await assert.rejects(adapter.getOrder({ ...reference, ...other }), /MODE_MISMATCH/);
    await assert.rejects(adapter.getOrders(other), /MODE_MISMATCH/);
    await assert.rejects(adapter.getTrades(scope, { ...reference, ...other }), /MODE_MISMATCH/);
    await assert.rejects(adapter.cancelOrder({ ...reference, ...other }), /MODE_MISMATCH/);
    await assert.rejects(adapter.advance({ ...reference, ...other }), /MODE_MISMATCH/);
  }
  await assert.rejects(adapter.getOrder({ ...reference, brokerNamespace: "other" }), /NAMESPACE_MISMATCH/);
  assert.deepEqual(await adapter.getOrder(lookup), before);
});
test("equivalent injected clocks, IDs and scenarios produce identical complete evidence", async () => {
  const plan: PaperScenario = { submission: "AMBIGUOUS", steps: [fillStep(40), { kind: "CONFIRM_CANCEL" }] };
  const run = async () => {
    const adapter = broker(plan); const submission = await adapter.submitOrder(request);
    const partial = await adapter.advance(lookup); const cancellation = await adapter.cancelOrder(await ref(adapter));
    const terminal = await adapter.advance(lookup);
    return { submission, partial, cancellation, terminal, orders: await adapter.getOrders(scope), trades: await adapter.getTrades(scope) };
  };
  assert.deepEqual(await run(), await run());
});
test("observation lookups cannot hide contradictory broker identity behind internal order ID", async () => {
  const adapter = broker(); await adapter.submitOrder(request);
  const observation = await adapter.getOrder(lookup); assert.ok(observation);
  await assert.rejects(adapter.cancelOrder({ ...observation, brokerNamespace: "wrong" }), /NAMESPACE_MISMATCH/);
  const contradictory = { ...observation, orderId: "other" };
  await assert.rejects(adapter.getOrder(contradictory), /ORDER_IDENTITY_MISMATCH/);
  await assert.rejects(adapter.getTrades(scope, contradictory), /ORDER_IDENTITY_MISMATCH/);
  assert.deepEqual(await adapter.getOrder(lookup), observation);
});
test("request and scenario mutation after submission cannot change broker state", async () => {
  const input = { ...request }; const plan = { submission: "ACCEPTED" as const, steps: [fillStep(130)] };
  const adapter = broker(plan); await adapter.submitOrder(input);
  input.quantityUnits = 1; plan.steps[0].quantityUnits = 1;
  const result = await adapter.advance(lookup); assert.equal(result.requestedUnits, 130); assert.equal(result.filledUnits, 130);
  assert.throws(() => Object.assign(result, { filledUnits: 0 }), TypeError);
  assert.equal((await adapter.getOrder(lookup))?.filledUnits, 130);
});
test("normalized request validates units, fixed-point prices and order-type consistency", () => {
  for (const mutation of [{ quantityUnits: 0 }, { quantityUnits: 1.5 }, { quantityUnits: Number.MAX_SAFE_INTEGER + 1 },
    { limitPriceMinor: -1 }, { limitPriceMinor: 0.1 }, { limitPriceMinor: undefined }, { orderType: "MARKET" },
    { executionMode: "LIVE" }, { legId: " " }]) assert.equal(brokerOrderRequestSchema.safeParse({ ...request, ...mutation }).success, false);
  assert.equal(brokerOrderRequestSchema.safeParse({ ...request, orderType: "MARKET", limitPriceMinor: undefined }).success, true);
});
test("invalid requests never copy secrets or unknown raw fields into diagnostics", async () => {
  const adapter = broker();
  const result = await adapter.submitOrder({ ...request, authorization: "secret-token" } as BrokerOrderRequest);
  assert.equal(result.kind, "REJECTED"); assert.ok(!JSON.stringify(result).includes("secret-token"));
  assert.deepEqual(await adapter.getOrders(scope), []);
});
test("scenario prices obey BUY and SELL limit prices and require safe integer units", async () => {
  await assert.rejects(broker({ submission: "ACCEPTED", initialFills: [{ quantityUnits: 130, priceMinor: 10001 }] }).submitOrder(request), /LIMIT_VIOLATION/);
  await assert.rejects(broker({ submission: "ACCEPTED", initialFills: [fill(130)] }).submitOrder({ ...request, side: "SELL" }), /LIMIT_VIOLATION/);
  await assert.rejects(broker({ submission: "ACCEPTED", initialFills: [fill(0.5)] }).submitOrder(request));
});
test("duplicate generated trade identity fails without publishing a duplicate trade", async () => {
  let id = 0;
  const adapter = new PaperBrokerAdapter(scope, { clock: { now: () => "2026-09-12T04:00:00.000Z" },
    ids: { nextId: kind => kind === "TRADE" ? "same-trade" : `${kind}-${++id}` },
    scenario: () => ({ submission: "ACCEPTED", steps: [fillStep(40), fillStep(90)] }) });
  await adapter.submitOrder(request); await adapter.advance(lookup);
  await assert.rejects(adapter.advance(lookup), /DUPLICATE_GENERATED_ID/);
  assert.equal((await adapter.getTrades(scope)).length, 1); assert.equal((await adapter.getOrder(lookup))?.filledUnits, 40);
});
test("unknown order lookups are explicit and trade lookup can filter one order", async () => {
  const adapter = broker({ submission: "ACCEPTED", initialFills: [fill(130)] });
  assert.equal(await adapter.getOrder(lookup), null);
  await adapter.submitOrder(request); const reference = await ref(adapter);
  await adapter.submitOrder({ ...request, orderId: "order-2", claimId: "claim-2" });
  assert.equal((await adapter.getTrades(scope)).length, 2); assert.equal((await adapter.getTrades(scope, reference)).length, 1);
  const result = await adapter.cancelOrder({ ...reference, brokerOrderId: "missing" }); assert.equal(result.kind, "REJECTED");
});
test("paper capabilities are explicit and adapter sources have no persistence/network/timer dependencies", () => {
  const adapter = broker();
  assert.equal(adapter.capabilities.submissionIdempotency, "DURABLE_CLAIM_ID");
  assert.equal(adapter.capabilities.modification, false); assert.equal(adapter.capabilities.streaming, false);
  for (const name of ["BrokerAdapter.ts", "PaperBrokerAdapter.ts"]) {
    const source = readFileSync(join(__dirname, "../../src/brokers", name), "utf8");
    assert.doesNotMatch(source, /Math\.random|Date\.now|new Date\(|setTimeout\(|setInterval\(|fetch\(|mongoose|axios|\.save\(/);
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map(match => match[1]);
    assert.ok(imports.every(path => ["zod", "@trading-bot/shared", "./BrokerAdapter"].includes(path)));
  }
});

for (const submission of ["ACCEPTED", "AMBIGUOUS"] as const) {
  for (const [name, mutation] of [
    ["identical claim", {}], ["conflicting claim payload", { quantityUnits: 9 }],
    ["different claim for same physical order", { claimId: "claim-2" }],
  ] as const) test(`reserved ${submission} submission blocks scenario re-entry: ${name}`, async () => {
    const tenUnits = { ...request, quantityUnits: 10 };
    let id = 0, evaluations = 0;
    const nested: Promise<void>[] = [];
    const adapter = new PaperBrokerAdapter(scope, {
      clock: { now: () => "2026-09-13T04:00:00.000Z" }, ids: { nextId: kind => `${kind}-${++id}` },
      scenario: () => {
        evaluations++;
        nested.push(assert.rejects(adapter.submitOrder({ ...tenUnits, ...mutation }), /BROKER_MUTATION_IN_PROGRESS/));
        nested.push(adapter.getOrders(scope).then(orders => assert.deepEqual(orders, [])));
        nested.push(adapter.getTrades(scope).then(trades => assert.deepEqual(trades, [])));
        return { submission, initialFills: [fill(10)] };
      },
    });
    const result = await adapter.submitOrder(tenUnits); await Promise.all(nested);
    assert.equal(result.kind, submission); assert.equal(evaluations, 1);
    const orders = await adapter.getOrders(scope), trades = await adapter.getTrades(scope);
    assert.equal(orders.length, 1); assert.equal(orders[0].orderId, tenUnits.orderId);
    assert.equal(orders[0].filledUnits, 10);
    assert.equal(trades.reduce((total, trade) => total + trade.quantityUnits, 0), 10);
    assert.equal(new Set(trades.map(trade => trade.brokerTradeKey)).size, trades.length);
    assert.ok(trades.every(trade => trade.brokerOrderId === orders[0].brokerOrderId));
    assert.deepEqual(await adapter.submitOrder(tenUnits), result);
    assert.deepEqual(await adapter.getOrders(scope), orders);
  });
}

for (const dependency of ["clock", "ids"] as const) test(`re-entry from ${dependency}, including rejection diagnostics, cannot recurse or duplicate execution`, async () => {
  let id = 0;
  const nested: Promise<void>[] = [];
  const reenter = () => nested.push(assert.rejects(adapter.submitOrder(request), /BROKER_MUTATION_IN_PROGRESS/));
  const adapter = new PaperBrokerAdapter(scope, {
    clock: { now: () => { if (dependency === "clock") reenter(); return "2026-09-13T04:00:00.000Z"; } },
    ids: { nextId: kind => { if (dependency === "ids") reenter(); return `${kind}-${++id}`; } },
    scenario: () => ({ submission: "ACCEPTED", initialFills: [fill(130)] }),
  });
  await adapter.submitOrder(request);
  assert.equal((await adapter.submitOrder({ ...request, quantityUnits: 129 })).kind, "REJECTED");
  assert.equal((await adapter.submitOrder({ ...request, quantityUnits: 0 })).kind, "REJECTED");
  await Promise.all(nested); assert.ok(nested.length > 1 && nested.length < 20);
  assert.equal((await adapter.getOrders(scope)).length, 1);
  assert.deepEqual((await adapter.getTrades(scope)).map(trade => trade.quantityUnits), [130]);
});

test("throwing scenario releases both reservations with no fake acceptance and permits explicit retry", async () => {
  let attempts = 0, id = 0;
  const nested: Promise<void>[] = [];
  const adapter = new PaperBrokerAdapter(scope, {
    clock: { now: () => "2026-09-13T04:00:00.000Z" }, ids: { nextId: kind => `${kind}-${++id}` },
    scenario: () => {
      if (++attempts === 1) {
        nested.push(assert.rejects(adapter.submitOrder(request), /BROKER_MUTATION_IN_PROGRESS/));
        throw new Error("scenario-failure");
      }
      return { submission: "ACCEPTED", initialFills: [fill(130)] };
    },
  });
  await assert.rejects(adapter.submitOrder(request), /scenario-failure/); await Promise.all(nested);
  assert.deepEqual(await adapter.getOrders(scope), []); assert.deepEqual(await adapter.getTrades(scope), []);
  const receipt = await adapter.submitOrder(request); assert.equal(receipt.kind, "ACCEPTED");
  assert.deepEqual(await adapter.submitOrder(request), receipt); assert.equal(attempts, 2);
  assert.equal((await adapter.getOrders(scope)).length, 1);
  assert.deepEqual((await adapter.getTrades(scope)).map(trade => trade.quantityUnits), [130]);
});

test("dependency failure after a staged initial fill publishes nothing and releases ownership", async () => {
  let calls = 0, id = 0;
  const adapter = new PaperBrokerAdapter(scope, {
    clock: { now: () => { if (++calls === 3) throw new Error("clock-failure"); return "2026-09-13T04:00:00.000Z"; } },
    ids: { nextId: kind => `${kind}-${++id}` },
    scenario: () => ({ submission: "ACCEPTED", initialFills: [fill(40), fill(90)] }),
  });
  await assert.rejects(adapter.submitOrder(request), /clock-failure/);
  assert.deepEqual(await adapter.getOrders(scope), []); assert.deepEqual(await adapter.getTrades(scope), []);
  await adapter.submitOrder(request);
  assert.equal((await adapter.getOrders(scope)).length, 1);
  assert.deepEqual((await adapter.getTrades(scope)).map(trade => trade.quantityUnits), [40, 90]);
});

function claimedFoundationOrder() {
  const initial = { ...foundation.orderState(), ...scope, legId: request.legId, quantityUnits: request.quantityUnits };
  assert.equal(initial.lastObservationVersion, 0);
  const authorized = foundation.value(transitionOrder(initial, { type: "AUTHORIZE",
    authorization: { ...foundation.authorization(), ...scope, reservedQuantityUnits: request.quantityUnits } }));
  return foundation.value(transitionOrder(authorized, { type: "CLAIM_SUBMISSION", nowMs: 1000, executionEpoch: 1, policyVersion: 1 }));
}
function workingObservationEvent(observation: BrokerOrderObservation): OrderEvent {
  return { type: "BROKER_OBSERVED", phase: observation.state === "OPEN" ? "ACKNOWLEDGED"
    : observation.state === "PENDING_ACK" ? "SUBMITTED" : observation.state,
    cumulativeFilledUnits: observation.filledUnits, observationVersion: observation.observationVersion,
    evidenceRef: observation.evidence.reference };
}
test("first accepted OPEN observation applies to actual Phase 2A initial order at version 1", async () => {
  const adapter = broker(); await adapter.submitOrder(request);
  const observation = await adapter.getOrder(lookup); assert.ok(observation);
  assert.equal(observation.observationVersion, 1);
  const applied = foundation.value(transitionOrder(claimedFoundationOrder(), workingObservationEvent(observation)));
  assert.equal(applied.phase, "ACKNOWLEDGED"); assert.equal(applied.lastObservationVersion, 1);
});
test("Phase 2A consumes paper versions directly: duplicate, conflict, later and stale observations", async () => {
  const adapter = broker({ submission: "ACCEPTED", delayedAcknowledgement: true, steps: [{ kind: "ACKNOWLEDGE" }] });
  await adapter.submitOrder(request);
  const first = await adapter.getOrder(lookup); assert.ok(first); assert.equal(first.observationVersion, 1);
  const event = workingObservationEvent(first);
  const applied = foundation.value(transitionOrder(claimedFoundationOrder(), event));
  assert.equal(applied.phase, "SUBMITTED"); assert.equal(applied.lastObservationVersion, 1);
  assert.deepEqual(foundation.value(transitionOrder(applied, event)), applied);
  const conflict = transitionOrder(applied, workingObservationEvent({ ...first, state: "OPEN" }));
  assert.equal(conflict.ok, false); if (!conflict.ok) assert.equal(conflict.error.code, "DUPLICATE_CONFLICT");
  const second = await adapter.advance(lookup); assert.equal(second.observationVersion, 2);
  const updated = foundation.value(transitionOrder(applied, workingObservationEvent(second)));
  assert.equal(updated.phase, "ACKNOWLEDGED"); assert.equal(updated.lastObservationVersion, 2);
  const stale = transitionOrder(updated, event);
  assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, "OBSERVATION_REGRESSION");
  assert.equal(updated.filledUnits, 0); assert.equal(updated.lastObservationVersion, 2);
  assert.deepEqual(await adapter.getOrder(lookup), second);
});

test("padded submission, lookup, filter, cancellation and advance share one canonical identity", async () => {
  const adapter = broker({ submission: "AMBIGUOUS", initialFills: [fill(40)], steps: [fillStep(25), { kind: "CONFIRM_CANCEL" }] });
  const paddedScope = { ...scope, accountId: ` ${scope.accountId} ` };
  const receipt = await adapter.submitOrder({ ...request, ...paddedScope, orderId: " order-1 ", claimId: " claim-1 " });
  assert.equal(receipt.kind, "AMBIGUOUS");
  const paddedLookup = { ...paddedScope, orderId: " order-1 " };
  const first = await adapter.getOrder(paddedLookup); assert.ok(first);
  assert.equal(first.orderId, "order-1"); assert.equal(first.accountId, scope.accountId);
  assert.deepEqual(await adapter.getOrder(lookup), first); assert.deepEqual(await adapter.getOrders(paddedScope), [first]);
  const paddedReference = { ...first, ...paddedScope, orderId: " order-1 ",
    brokerOrderId: ` ${first.brokerOrderId} `, brokerNamespace: ` ${first.brokerNamespace} ` };
  assert.deepEqual(await adapter.getOrder(paddedReference), first);
  assert.equal((await adapter.getTrades(paddedScope, paddedReference)).length, 1);
  const partial = await adapter.advance(paddedLookup); assert.equal(partial.filledUnits, 65);
  assert.deepEqual(await adapter.submitOrder(request), receipt);
  assert.equal((await adapter.cancelOrder(paddedReference)).kind, "ACCEPTED");
  const cancelled = await adapter.advance(paddedReference); assert.equal(cancelled.state, "CANCELLED");
  assert.equal(cancelled.filledUnits, 65);
  assert.deepEqual(await adapter.getOrders(paddedScope), [cancelled]);
  assert.deepEqual(await adapter.getTrades(paddedScope, paddedReference), await adapter.getTrades(scope, first));
  assert.deepEqual(await adapter.submitOrder(request), receipt);
  assert.deepEqual(await adapter.getOrder(paddedLookup), cancelled);
});
test("whitespace cannot split a claim or physical order, or bypass namespace/account isolation", async () => {
  const adapter = broker(); const receipt = await adapter.submitOrder(request);
  assert.deepEqual(await adapter.submitOrder({ ...request, claimId: " claim-1 ", orderId: " order-1 " }), receipt);
  assert.equal((await adapter.submitOrder({ ...request, claimId: " claim-1 ", quantityUnits: 129 })).kind, "REJECTED");
  assert.equal((await adapter.submitOrder({ ...request, claimId: " claim-2 ", orderId: " order-1 " })).kind, "REJECTED");
  const reference = await ref(adapter);
  await assert.rejects(adapter.getOrder({ ...reference, accountId: " PAPER:other " }), /MODE_MISMATCH/);
  await assert.rejects(adapter.cancelOrder({ ...reference, brokerNamespace: " wrong " }), /NAMESPACE_MISMATCH/);
  const mismatched = { ...reference, orderId: " other " };
  await assert.rejects(adapter.getTrades(scope, mismatched), /ORDER_IDENTITY_MISMATCH/);
  assert.equal((await adapter.getOrders(scope)).length, 1);
});

for (const outer of ["submit", "advance", "cancel"] as const) {
  for (const inner of ["submit", "advance", "cancel"] as const) {
    test(`mutation isolation: ${outer} blocks nested ${inner} before clock/ID callbacks can expose staged state`, async () => {
      for (const dependency of ["clock", "ids"] as const) {
        for (const stage of ["unfilled", "partial", "completion", "cancel-pending"] as const) {
          let sequence = 0, armed = false;
          const checks: Promise<void>[] = [];
          const plan: PaperScenario = { submission: "ACCEPTED",
            initialFills: stage === "unfilled" ? [] : [fill(40)],
            steps: [fillStep(stage === "completion" ? 90 : 25), { kind: "CONFIRM_CANCEL" }] };
          let beforeOrders: readonly BrokerOrderObservation[] = [];
          let beforeTrades: Awaited<ReturnType<BrokerAdapter["getTrades"]>> = [];
          let reference: BrokerOrderReference = { ...scope, brokerNamespace: "PAPER_SIM_V1", brokerOrderId: "unpublished" };
          const invoke = (operation: typeof outer) => operation === "submit" ? adapter.submitOrder(request)
            : operation === "advance" ? adapter.advance(lookup) : adapter.cancelOrder(reference);
          const callback = () => {
            if (!armed) return;
            checks.push(assert.rejects(invoke(inner), error => error instanceof Error
              && error.message === "BROKER_MUTATION_IN_PROGRESS" && !("kind" in error)));
            checks.push(adapter.getOrders(scope).then(orders => assert.deepEqual(orders, beforeOrders)));
            checks.push(adapter.getTrades(scope).then(trades => assert.deepEqual(trades, beforeTrades)));
            checks.push(adapter.getOrder(lookup).then(order => assert.deepEqual(order, beforeOrders[0] ?? null)));
          };
          const adapter = new PaperBrokerAdapter(scope, {
            clock: { now: () => { if (dependency === "clock") callback(); return "2026-09-16T04:00:00.000Z"; } },
            ids: { nextId: kind => { if (dependency === "ids") callback(); return `${kind}-${++sequence}`; } },
            scenario: () => plan,
          });
          if (outer !== "submit") {
            await adapter.submitOrder(request); reference = await ref(adapter);
            if (stage === "cancel-pending") await adapter.cancelOrder(reference);
            beforeOrders = await adapter.getOrders(scope); beforeTrades = await adapter.getTrades(scope);
          }
          armed = true; await invoke(outer); armed = false; await Promise.all(checks);
          // Already accepted cancellation replays without invoking dependencies.
          assert.equal(checks.length > 0, !(outer === "cancel" && stage === "cancel-pending"));
          const orders = await adapter.getOrders(scope), trades = await adapter.getTrades(scope);
          assert.equal(orders.length, 1);
          assert.ok(orders[0].filledUnits <= request.quantityUnits);
          assert.equal(trades.reduce((sum, trade) => sum + trade.quantityUnits, 0), orders[0].filledUnits);
          assert.equal(new Set(trades.map(trade => trade.brokerTradeKey)).size, trades.length);
          assert.deepEqual(trades.slice(0, beforeTrades.length), beforeTrades);
          const version = beforeOrders[0]?.observationVersion ?? 0;
          assert.equal(orders[0].observationVersion, outer === "submit" ? (stage === "unfilled" ? 1 : 2)
            : version + (outer === "cancel" && stage === "cancel-pending" ? 0 : 1));
          if (outer === "cancel" || (outer === "advance" && stage === "cancel-pending")) {
            assert.equal(orders[0].cancellation, "REQUESTED");
            if (outer === "cancel") await adapter.advance(lookup);
            const terminal = await adapter.advance(lookup);
            assert.equal(terminal.cancellation, "CONFIRMED");
            assert.equal(terminal.state, stage === "completion" ? "FILLED" : "CANCELLED");
          }
        }
      }
    });
  }
}

for (const operation of ["advance", "cancel"] as const) test(`${operation} dependency failure preserves committed evidence and permits explicit retry`, async () => {
  for (const dependency of operation === "advance" ? ["clock", "EVIDENCE", "TRADE"] : ["clock", "EVIDENCE"]) {
    let armed = false, sequence = 0;
    const fail = (kind: string) => { if (armed && kind === dependency) { armed = false; throw new Error("injected-failure"); } };
    const adapter = new PaperBrokerAdapter(scope, {
      clock: { now: () => { fail("clock"); return "2026-09-16T04:00:00.000Z"; } },
      ids: { nextId: kind => { fail(kind); return `${kind}-${++sequence}`; } },
      scenario: () => ({ submission: "ACCEPTED", initialFills: [fill(40)], steps: [fillStep(90), { kind: "CONFIRM_CANCEL" }] }),
    });
    await adapter.submitOrder(request); const reference = await ref(adapter);
    const before = await adapter.getOrder(lookup), trades = await adapter.getTrades(scope);
    const invoke = () => operation === "advance" ? adapter.advance(lookup) : adapter.cancelOrder(reference);
    armed = true; await assert.rejects(invoke(), /injected-failure/);
    assert.deepEqual(await adapter.getOrder(lookup), before); assert.deepEqual(await adapter.getTrades(scope), trades);
    await invoke(); const after = await adapter.getOrder(lookup); assert.ok(after && before);
    assert.equal(after.observationVersion, before.observationVersion + 1);
    if (operation === "advance") assert.equal(after.filledUnits, 130);
    else {
      assert.equal(after.cancellation, "REQUESTED");
      await adapter.advance(lookup); assert.equal((await adapter.advance(lookup)).cancellation, "CONFIRMED");
    }
  }
});

for (const initialUnits of [40, 130]) test(`real ${initialUnits}-unit paper fill evidence precedes idempotent status/version consumption`, async () => {
  const adapter = broker({ submission: "ACCEPTED", initialFills: [fill(initialUnits)],
    steps: initialUnits === 40 ? [fillStep(90)] : [] });
  await adapter.submitOrder(request);
  const first = await adapter.getOrder(lookup); assert.ok(first);
  const event = workingObservationEvent(first);
  let state = claimedFoundationOrder();
  const premature = transitionOrder(state, event);
  assert.equal(premature.ok, false); if (!premature.ok) assert.equal(premature.error.code, "EVIDENCE_REQUIRED");
  const ingestTrades = async () => {
    for (const trade of await adapter.getTrades(scope)) {
      state = foundation.value(transitionOrder(state, { type: "APPLY_FILL", fill: {
        ...trade, fillId: trade.brokerTradeKey, source: "SIMULATED_FILL", evidenceRef: trade.evidence.reference,
      } }));
    }
  };
  await ingestTrades(); const fills = state.fills;
  state = foundation.value(transitionOrder(state, event));
  assert.equal(state.lastObservationVersion, first.observationVersion);
  assert.equal(state.phase, first.state); assert.equal(state.filledUnits, initialUnits);
  assert.deepEqual(state.fills, fills);
  assert.deepEqual(foundation.value(transitionOrder(state, event)), state);
  for (const mutation of [{ cumulativeFilledUnits: initialUnits - 1 }, { evidenceRef: "different-evidence" }, { phase: "REJECTED" as const }]) {
    const conflict = transitionOrder(state, { ...event, ...mutation });
    assert.equal(conflict.ok, false); if (!conflict.ok) assert.equal(conflict.error.code, "DUPLICATE_CONFLICT");
  }
  assert.deepEqual(await adapter.getOrder(lookup), first);
  if (initialUnits === 40) {
    const next = await adapter.advance(lookup); await ingestTrades();
    // New fills do not turn an exact replay of the last snapshot into a conflict/regression.
    assert.deepEqual(foundation.value(transitionOrder(state, event)), state);
    state = foundation.value(transitionOrder(state, workingObservationEvent(next)));
    assert.equal(state.phase, "FILLED"); assert.equal(state.filledUnits, 130);
    assert.equal(state.lastObservationVersion, next.observationVersion);
    assert.deepEqual(foundation.value(transitionOrder(state, workingObservationEvent(next))), state);
    const stale = transitionOrder(state, event);
    assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, "OBSERVATION_REGRESSION");
  }
});
