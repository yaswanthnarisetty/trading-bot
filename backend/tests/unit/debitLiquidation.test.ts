import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { familyFixture } from "../fixtures/strategyFamilies";
import { fixtureParams } from "../fixtures/historicalReplay";
import { evaluateHistoricalBar, normalizeBacktestParams, prepareReplay,
  type BacktestRunParams, type HistoricalReplayDataset, type ReplayProposalSource } from "../../src/domain/historicalReplay";
import { runHistoricalBacktest } from "../../src/services/BacktestService";

let attempts = 0;
const original = { hr: http.request, hg: http.get, sr: https.request, sg: https.get, fetch: globalThis.fetch };
before(() => {
  const block = () => { attempts++; throw new Error("NETWORK_FORBIDDEN"); };
  http.request = block as typeof http.request; http.get = block as typeof http.get;
  https.request = block as typeof https.request; https.get = block as typeof https.get; globalThis.fetch = block as typeof fetch;
});
after(() => {
  http.request = original.hr; http.get = original.hg; https.request = original.sr; https.get = original.sg; globalThis.fetch = original.fetch;
  assert.equal(attempts, 0);
});
const directions = ["BULLISH", "BEARISH"] as const;
type Direction = typeof directions[number];
const proposal = (direction: Direction): ReplayProposalSource => ({ version: "DEBIT_CLOSE_FIXTURE_V1",
  propose: () => ({ direction, confidence: 0.8, reason: "FIXTURE_DIRECTION" }) });
async function scenario(direction: Direction, longBid = 19900, shortAsk = 20100) {
  const base = await familyFixture();
  const params: BacktestRunParams = { ...fixtureParams(base), strategyFamily: "DEBIT_VERTICAL",
    initialCapital: 500000, riskPerTradePct: 10 };
  const config = normalizeBacktestParams(params), source = proposal(direction);
  const entry = evaluateHistoricalBar(prepareReplay(base, config), 49, config, source);
  assert.equal(entry.result.action, "CANDIDATE"); if (entry.result.action !== "CANDIDATE") throw Error("candidate required");
  const candidate = entry.result.candidate;
  const long = candidate.legs.find(l => l.side === "BUY")!, short = candidate.legs.find(l => l.side === "SELL")!;
  const data: HistoricalReplayDataset = { ...base, optionQuotes: base.optionQuotes.map(q => {
    if (q.timestamp <= entry.evaluatedAt) return q;
    if (q.canonicalId === long.canonicalId) return { ...q, bidMinor: longBid, askMinor: longBid + 400, lastPriceMinor: longBid + 200 };
    if (q.canonicalId === short.canonicalId) return { ...q, bidMinor: 19700, askMinor: shortAsk, lastPriceMinor: 19900 };
    return q;
  }) };
  return { base, params, source, candidate, long, short, data, at: entry.evaluatedAt };
}
const run = (s: Awaited<ReturnType<typeof scenario>>, patch: Partial<BacktestRunParams> = {}, data = s.data,
  source = s.source) => runHistoricalBacktest({ ...s.params, ...patch }, { provider: { load: async () => data },
  proposalSource: source, runTimestamp: "2026-09-30T12:00:00.000Z" });

for (const direction of directions) {
  test(`${direction} overlapping books close at exact -3900 with STOP_HIT`, async () => {
    const s = await scenario(direction), r = await run(s), t = r.trades[0]!;
    assert.equal(r.status, "COMPLETE"); assert.equal(r.totalTraded, 1); assert.equal(r.totalTrades, 1);
    assert.equal(r.missingExitObservations, 0); assert.equal(r.unresolvedPositions.length, 0);
    assert.equal(t.exitReason, "STOP_HIT"); assert.equal(t.quantityUnits, 65); assert.equal(t.lots, 1);
    const buy = t.legs.find(l => l.side === "BUY")!, sell = t.legs.find(l => l.side === "SELL")!;
    assert.equal(buy.canonicalId, s.long.canonicalId); assert.equal(sell.canonicalId, s.short.canonicalId);
    assert.equal(buy.entryFillMinor, 25250); assert.equal(sell.entryFillMinor, 19750);
    assert.equal(buy.exitFillMinor, 19750); assert.equal(sell.exitFillMinor, 20250);
    assert.equal((buy.exitFillMinor - sell.exitFillMinor) * 65, -32500);
    assert.equal(t.entryDebit, 3575); assert.equal(t.maxLoss, 3575); assert.equal(t.capitalReserved, 3770);
    assert.equal(t.pnlMinor, -390000); assert.equal(t.pnl, -3900); assert.equal(r.netPnL, -3900);
    assert.equal(r.finalCapital, r.initialCapital - 3900); assert.equal(r.maxDrawdown, 3900);
    assert.equal(t.slippageCost, 390); assert.equal(t.grossPnL - t.slippageCost, t.pnl);
    assert.equal(s.candidate.maxLossPerLotMinor, 338000); assert.equal(s.candidate.executionAuthority, "NONE");
    assert.ok(-t.pnl > t.maxLoss && -t.pnl > t.capitalReserved);
    const config = normalizeBacktestParams(s.params);
    assert.deepEqual(evaluateHistoricalBar(prepareReplay(s.data, config), 49, config, s.source).result,
      evaluateHistoricalBar(prepareReplay(s.base, config), 49, config, s.source).result);
  });
  for (const [label, bid, netExit] of [["positive", 21000, 600], ["zero", 20400, 0],
    ["raw zero with adverse slippage", 20100, -300]] as const) {
    test(`${direction} ${label} liquidation preserves signed exact cash`, async () => {
      const s = await scenario(direction, bid), r = await run(s), t = r.trades[0]!;
      assert.equal(r.status, "COMPLETE"); assert.equal(r.totalTrades, 1); assert.equal(r.missingExitObservations, 0);
      const buy = t.legs.find(l => l.side === "BUY")!, sell = t.legs.find(l => l.side === "SELL")!;
      assert.equal(buy.exitFillMinor - sell.exitFillMinor, netExit);
      assert.equal(t.pnlMinor, (-5500 + netExit) * 65);
      assert.equal(r.finalCapital, r.initialCapital + t.pnl); assert.equal(r.unresolvedPositions.length, 0);
    });
  }
  for (const reason of ["EOD_CLOSE", "END_OF_DATA"] as const) {
    test(`${direction} negative proceeds honor forced ${reason}`, async () => {
      const s = await scenario(direction);
      const patch = reason === "EOD_CLOSE" ? { entryCutoffMinute: 810, eodCloseMinute: 810 }
        : { to: new Date(Date.parse(s.at) + 300000).toISOString() };
      const r = await run(s, patch);
      assert.equal(r.trades[0]!.exitReason, reason); assert.equal(r.trades[0]!.pnl, -3900);
      assert.equal(r.status, "COMPLETE"); assert.equal(r.missingExitObservations, 0); assert.equal(r.unresolvedPositions.length, 0);
    });
  }
  test(`${direction} negative proceeds meet stop before a simultaneously due time exit`, async () => {
    const r = await run(await scenario(direction), { maxHoldingBars: 1 });
    assert.equal(r.trades[0]!.exitReason, "STOP_HIT"); assert.equal(r.trades[0]!.barsHeld, 1);
    assert.equal(r.trades[0]!.pnl, -3900); assert.equal(r.missingExitObservations, 0);
  });
  test(`${direction} negative equity does not suppress close; later entry lacks capacity`, async () => {
    const s = await scenario(direction, 19900, 100000);
    const source: ReplayProposalSource = { version: "DEBIT_CLOSE_THEN_REVERSE_V1", propose: ({ evaluatedAt }) => ({
      direction: evaluatedAt <= s.at ? direction : direction === "BULLISH" ? "BEARISH" : "BULLISH",
      confidence: 0.8, reason: "FIXTURE_DIRECTION" }) };
    const r = await run(s, { initialCapital: 40000 }, s.data, source);
    assert.equal(r.totalTraded, 1); assert.equal(r.totalTrades, 1); assert.equal(r.trades[0]!.pnl, -55835);
    assert.equal(r.finalCapital, -15835); assert.equal(r.netPnL, -55835);
    assert.equal(r.status, "COMPLETE"); assert.equal(r.unresolvedPositions.length, 0); assert.equal(r.missingExitObservations, 0);
    assert.ok(r.decisions.some(d => d.simulationReason === "insufficient_simulated_capacity"));
  });
  test(`${direction} a missing physical exit leg remains incomplete`, async () => {
    const s = await scenario(direction);
    const r = await run(s, {}, { ...s.data, optionQuotes: s.data.optionQuotes.filter(q =>
      q.timestamp <= s.at || q.canonicalId !== s.short.canonicalId) });
    assert.equal(r.status, "INCOMPLETE"); assert.equal(r.totalTrades, 0);
    assert.equal(r.unresolvedPositions.length, 1); assert.ok(r.missingExitObservations > 0);
  });
}
for (const [name, patch] of [["crossed", { bidMinor: 20400, askMinor: 20300 }],
  ["zero ask", { askMinor: 0 }], ["fractional price", { bidMinor: 19900.5 }],
  ["malformed depth", { bidQuantity: -1 }]] as const) {
  test(`invalid individual ${name} evidence still rejects`, async () => {
    const s = await scenario("BULLISH");
    await assert.rejects(() => run(s, {}, { ...s.data, optionQuotes: s.data.optionQuotes.map(q =>
      q.timestamp > s.at && q.canonicalId === s.long.canonicalId ? { ...q, ...patch } : q) }), /INVALID_HISTORICAL_OPTION_EVIDENCE/);
  });
}
test("signed debit replay remains offline and separated from financial execution", async () => {
  await run(await scenario("BULLISH")); await run(await scenario("BEARISH"));
  assert.equal(attempts, 0);
  assert.deepEqual(Object.keys(require.cache).filter(path => /\/src\/(?:models\/|services\/(?:RiskAdmissionService|RiskSettlementService|OrderManager|PaperBroker|FillProcessor|SignalLoopService|LLMService)\.)/.test(path)), []);
});
