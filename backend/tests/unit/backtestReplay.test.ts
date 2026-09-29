import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { historicalFixture, fixtureParams, fixtureQuality, historicalCsv } from "../fixtures/historicalReplay";
import { normalizeBacktestParams, prepareReplay, evaluateHistoricalBar, deterministicReplayProposal,
  type HistoricalReplayDataset, type BacktestRunParams, type ReplayProposalSource } from "../../src/domain/historicalReplay";
import { runHistoricalBacktest } from "../../src/services/BacktestService";
import { evaluateStrategy } from "../../src/domain/strategyEvaluation";
import { assertQualifiedRealMarketData } from "../../src/services/KiteMarketDataService";
import { KiteInstrumentMasterService } from "../../src/services/KiteInstrumentMasterService";
import { qualifyIndexMaster } from "../../src/services/KiteIndexDataService";
import { createBacktestHandler, createBacktestRouter } from "../../src/routes/backtest";

let networkCalls = 0;
const original = { httpRequest: http.request, httpsRequest: https.request, httpGet: http.get, httpsGet: https.get, fetch: globalThis.fetch };
before(() => {
  const block = () => { networkCalls++; throw new Error("External network forbidden in replay tests"); };
  http.request = block as typeof http.request; https.request = block as typeof https.request;
  http.get = block as typeof http.get; https.get = block as typeof https.get;
  globalThis.fetch = block as typeof fetch;
});
after(() => {
  http.request = original.httpRequest; https.request = original.httpsRequest;
  http.get = original.httpGet; https.get = original.httpsGet; globalThis.fetch = original.fetch;
  assert.equal(networkCalls, 0);
});
const recordedAt = "2026-09-30T12:00:00.000Z";
const replay = async (data: HistoricalReplayDataset, patch: Partial<BacktestRunParams> = {}, source?: ReplayProposalSource) =>
  runHistoricalBacktest({ ...fixtureParams(data), ...patch }, { provider: { load: async () => data }, proposalSource: source, runTimestamp: recordedAt });
const at = (data: HistoricalReplayDataset, n: number) => new Date(Date.parse(data.candles[n]!.timestamp) + 300000).toISOString();
const evaluation = (data: HistoricalReplayDataset, n = 49, patch: Partial<BacktestRunParams> = {}) => {
  const config = normalizeBacktestParams({ ...fixtureParams(data), ...patch });
  return evaluateHistoricalBar(prepareReplay(data, config), n, config);
};
const changeQuotes = (data: HistoricalReplayDataset, price: number, afterIndex = 49): HistoricalReplayDataset => ({ ...data,
  optionQuotes: data.optionQuotes.map(q => q.timestamp > at(data, afterIndex) && ["100010", "100012"].includes(q.instrumentToken)
    ? { ...q, bidMinor: price - 100, askMinor: price + 100, lastPriceMinor: price } : { ...q }) });
function remapTimes(data: HistoricalReplayDataset, times: string[]): HistoricalReplayDataset {
  const mapping = new Map(data.candles.map((c, i) => [at(data, i), new Date(Date.parse(times[i]!) + 300000).toISOString()]));
  return { ...data, candles: data.candles.map((c, i) => ({ ...c, timestamp: times[i]! })),
    coverage: { ...data.coverage, coveredFrom: times[0]!,
      coveredTo: new Date(Date.parse(times[times.length - 1]!) + 300000).toISOString(), expectedCandleStarts: times },
    optionQuotes: data.optionQuotes.map(q => ({ ...q, timestamp: mapping.get(q.timestamp)!, availableAt: mapping.get(q.timestamp)! })) };
}

test("replay uses the identical Phase 5B evaluator result and marks research authority NONE", async () => {
  const data = await historicalFixture(), e = evaluation(data);
  assert.equal(e.result.action, "CANDIDATE");
  assert.deepEqual(e.result, evaluateStrategy({ analytics: e.analytics, proposal: e.proposal,
    config: fixtureQuality, evaluatedAt: e.evaluatedAt }));
  if (e.result.action === "CANDIDATE") assert.equal(e.result.candidate.executionAuthority, "NONE");
});
test("later candle changes cannot change earlier indicators, digest or strategy decision", async () => {
  const data = await historicalFixture(), changed = { ...data, candles: data.candles.map((c, i) => i <= 49 ? c :
    { ...c, openMinor: c.openMinor + 20000, highMinor: c.highMinor + 20000, lowMinor: c.lowMinor + 20000, closeMinor: c.closeMinor + 20000, volume: 999999 }) };
  assert.deepEqual(evaluation(changed), evaluation(data));
});
test("later option prices and future exit outcome cannot change the earlier entry", async () => {
  const data = await historicalFixture(), changed = changeQuotes(data, 23000);
  const a = await replay(data), b = await replay(changed);
  assert.deepEqual(a.decisions[0], b.decisions[0]);
  assert.equal(a.trades[0]!.entryEvidenceId, b.trades[0]!.entryEvidenceId);
  assert.equal(a.trades[0]!.entryShortFillMinor, b.trades[0]!.entryShortFillMinor);
  assert.notEqual(a.trades[0]!.pnl, b.trades[0]!.pnl);
});
test("proposal source receives only historical timestamp and validated EMA alignment", async () => {
  const data = await historicalFixture();
  const source: ReplayProposalSource = { version: "INSPECT_V1", propose(input) {
    assert.deepEqual(Object.keys(input).sort(), ["emaAlignment", "evaluatedAt"]);
    assert.ok(Object.isFrozen(input)); return deterministicReplayProposal.propose(input);
  } };
  await replay(data, {}, source);
});
test("49 completed bars hold; future candles cannot warm up an earlier decision", async () => {
  const data = await historicalFixture();
  const e = evaluation(data, 48);
  assert.equal(e.result.action, "HOLD");
  assert.equal(e.analytics.available, false);
  if (!e.analytics.available) assert.equal(e.analytics.reason, "INSUFFICIENT_HISTORY");
  assert.equal(evaluation(data, 49).result.action, "CANDIDATE");
});
test("historical candle cutoff and Greek valuation use the completed bar end", async () => {
  const data = await historicalFixture(), e = evaluation(data);
  assert.equal(e.evaluatedAt, at(data, 49));
  assert.ok(e.analytics.available);
  if (!e.analytics.available) return;
  assert.equal(e.analytics.snapshot.indicators.range.to, data.candles[49]!.timestamp);
  assert.equal(e.analytics.snapshot.indicators.lastFinalizedAt, e.evaluatedAt);
  const greek = e.analytics.snapshot.options[0]!.greeks;
  assert.ok(greek.available);
  if (greek.available) { assert.equal(greek.value.valuationAt, e.evaluatedAt); assert.equal(greek.value.expiryAt, "2026-10-06T10:00:00.000Z"); }
});
for (const [field, value, reason] of [["maxAtrPoints", 0.01, "ATR_GATE"], ["bullishRsiMax", 50, "RSI_GATE"],
  ["minConfidence", 0.9, "CONFIDENCE_TOO_LOW"], ["minDepthUnits", 9999, "LIQUIDITY_GATE"]] as const)
  test(`shared ${reason} controls backtest outcome`, async () => {
    const data = await historicalFixture(), e = evaluation(data, 49, { strategyConfig: { ...fixtureQuality, [field]: value } });
    assert.deepEqual(e.result, { action: "HOLD", reason });
  });
test("permissive shared RSI/ATR config is not overridden by old backtest gates", async () => {
  const e = evaluation(await historicalFixture());
  assert.ok(e.analytics.available);
  if (e.analytics.available) assert.equal(e.analytics.snapshot.indicators.values.rsi, 100);
  assert.equal(e.result.action, "CANDIDATE");
});
test("missing exact hedge holds instead of generating a contract", async () => {
  const data = await historicalFixture();
  const e = evaluation({ ...data, optionQuotes: data.optionQuotes.filter(q => q.instrumentToken !== "100011") });
  assert.deepEqual(e.result, { action: "HOLD", reason: "NO_QUALIFIED_HEDGE" });
});
test("missing historical option observations reports explicit unavailability", async () => {
  const data = await historicalFixture();
  const r = await replay({ ...data, optionQuotes: [] });
  assert.equal(r.totalTrades, 0);
  assert.equal(r.status, "INCOMPLETE");
  assert.equal(r.missingEntryObservations, r.decisions.length);
  assert.ok(r.decisions.every(d => d.proposalReason === "HISTORICAL_OPTION_EVIDENCE_UNAVAILABLE"));
});
test("option evidence published after evaluation is unavailable at that evaluation", async () => {
  const data = await historicalFixture();
  const e = evaluation({ ...data, optionQuotes: data.optionQuotes.map(q => ({ ...q,
    availableAt: new Date(Date.parse(q.timestamp) + 1).toISOString() })) });
  assert.equal(e.proposalReason, "HISTORICAL_OPTION_EVIDENCE_UNAVAILABLE");
});
for (const [label, edit] of [
  ["unordered", (d: HistoricalReplayDataset) => ({ ...d, candles: [...d.candles].reverse() })],
  ["duplicate", (d: HistoricalReplayDataset) => ({ ...d, candles: [d.candles[0]!, ...d.candles] })],
  ["conflicting duplicate", (d: HistoricalReplayDataset) => ({ ...d, candles: [d.candles[0]!, { ...d.candles[0]!, volume: 999 }, ...d.candles.slice(1)] })],
  ["malformed OHLC", (d: HistoricalReplayDataset) => ({ ...d, candles: d.candles.map((c, n) => n ? c : { ...c, highMinor: 1 }) })],
] as const) test(`${label} candles reject`, async () => {
  const data = await historicalFixture();
  assert.throws(() => prepareReplay(edit(data), normalizeBacktestParams(fixtureParams(data))), /INVALID_CANDLE/);
});
test("current master cannot qualify a historical replay", async () => {
  const data = await historicalFixture();
  const master = await new KiteInstrumentMasterService({ getInstrumentsCsv: async () => historicalCsv },
    () => new Date("2026-09-30T00:00:00Z"), [{ underlying: "NIFTY", expiry: "2026-10-27", sourceReference: "FIXTURE" }]).load();
  assert.throws(() => prepareReplay({ ...data, master }, normalizeBacktestParams(fixtureParams(data))), /HISTORICAL_MASTER_NOT_KNOWN/);
});
for (const field of ["instrumentToken", "masterFingerprint", "canonicalId"] as const)
  test(`wrong historical ${field} rejects rather than remapping`, async () => {
    const data = await historicalFixture();
    assert.throws(() => prepareReplay({ ...data, optionQuotes: data.optionQuotes.map((q, n) => n ? q : { ...q, [field]: "wrong" }) },
      normalizeBacktestParams(fixtureParams(data))));
  });
test("duplicate historical quote rejects even if equal", async () => {
  const data = await historicalFixture();
  assert.throws(() => prepareReplay({ ...data, optionQuotes: [...data.optionQuotes, data.optionQuotes[0]!] },
    normalizeBacktestParams(fixtureParams(data))), /DUPLICATE_HISTORICAL_OPTION_EVIDENCE/);
});
test("quote input order normalizes without changing results", async () => {
  const data = await historicalFixture();
  assert.deepEqual(await replay(data), await replay({ ...data, optionQuotes: [...data.optionQuotes].reverse() }));
});
test("misaligned candle starts reject instead of changing replay availability", async () => {
  const data = await historicalFixture();
  assert.throws(() => prepareReplay({ ...data, candles: data.candles.map(c => ({ ...c,
    timestamp: new Date(Date.parse(c.timestamp) + 1000).toISOString() })) }, normalizeBacktestParams(fixtureParams(data))), /CANDLE_OUTSIDE_NSE_SESSION/);
});
test("nested strategy config cannot smuggle token or unknown metadata", async () => {
  const data = await historicalFixture();
  assert.throws(() => normalizeBacktestParams({ ...fixtureParams(data), strategyConfig: {
    ...fixtureQuality, instrumentToken: "100010" } }), /INVALID_BACKTEST_CONFIG/);
});
test("historical replay never obtains current KITE_REAL market issuance", async () => {
  const data = await historicalFixture(), e = evaluation(data);
  assert.ok(e.analytics.available);
  if (!e.analytics.available) return;
  const snapshot = e.analytics.snapshot;
  assert.equal(snapshot.dataMode, "MOCK");
  assert.throws(() => assertQualifiedRealMarketData(snapshot, {
    maxAgeMs: 1000, instrument: snapshot.options[0]!.instrument }));
  const r = await replay(data);
  assert.equal(r.dataMode, "HISTORICAL_REPLAY"); assert.equal(r.provider, "FIXTURE");
  assert.equal(r.metadata.historicalIdentity, "FIXTURE_ONLY");
});
test("winning trade uses both historical quotes, units once, and all four adverse slips", async () => {
  const r = await replay(await historicalFixture()), t = r.trades[0]!;
  assert.equal(t.lots, 1); assert.equal(t.quantityUnits, 65);
  assert.equal(t.entryShortFillMinor, 19750); assert.equal(t.entryHedgeFillMinor, 15250);
  assert.equal(t.exitShortFillMinor, 16750); assert.equal(t.exitHedgeFillMinor, 14750);
  assert.equal(t.grossPnL, 2015); assert.equal(t.slippageCost, 390); assert.equal(t.pnl, 1625);
  assert.equal(t.exitReason, "TARGET_HIT"); assert.equal(r.finalCapital, 201625);
});
test("losing trade uses observed exit prices and records realized drawdown from initial equity", async () => {
  const data = changeQuotes(await historicalFixture(), 23000), r = await replay(data);
  assert.equal(r.trades[0]!.exitReason, "STOP_HIT"); assert.equal(r.trades[0]!.pnl, -2600);
  assert.equal(r.finalCapital, 197400); assert.equal(r.maxDrawdown, 2600);
});
test("zero slippage changes P&L by exactly the configured round-trip cost", async () => {
  const data = await historicalFixture();
  const a = await replay(data), b = await replay(data, { slippageMinorPerLeg: 0 });
  assert.equal(b.netPnL - a.netPnL, 390); assert.equal(b.slippageCost, 0);
});
test("insufficient simulated capital does not force one lot", async () => {
  const r = await replay(await historicalFixture(), { initialCapital: 100 });
  assert.equal(r.totalTraded, 0); assert.ok(r.blockReasons.insufficient_simulated_capacity! > 0);
  assert.equal(r.finalCapital, 100);
});
test("displayed historical depth limits simulated whole lots", async () => {
  const data = await historicalFixture();
  const r = await replay({ ...data, optionQuotes: data.optionQuotes.map(q => ({ ...q, bidQuantity: 64, askQuantity: 64 })) });
  assert.equal(r.totalTraded, 0);
});
test("max concurrent simulated positions blocks further entry", async () => {
  const data = changeQuotes(await historicalFixture(), 20000);
  const r = await replay(data, { maxPositions: 1 });
  assert.equal(r.totalTraded, 1); assert.ok(r.blockReasons.max_positions! > 0);
});
test("max daily trades applies after completed exits", async () => {
  const r = await replay(await historicalFixture(), { maxDailyTrades: 1 });
  assert.equal(r.totalTraded, 1); assert.ok(r.blockReasons.daily_limit! > 0);
});
test("same logical candidate cannot reopen repeatedly on the same day", async () => {
  const r = await replay(await historicalFixture());
  assert.equal(r.totalTraded, 1); assert.ok(r.blockReasons.duplicate_strategy! > 0);
});
test("time exit uses replayed completed bar count", async () => {
  const r = await replay(changeQuotes(await historicalFixture(), 20000), { maxHoldingBars: 2 });
  assert.equal(r.trades[0]!.exitReason, "TIME_EXIT"); assert.equal(r.trades[0]!.barsHeld, 2);
});
test("terminal liquidation uses evidence at the declared replay horizon", async () => {
  const data = changeQuotes(await historicalFixture(), 20000), r = await replay(data);
  assert.equal(r.trades[0]!.exitReason, "END_OF_DATA"); assert.equal(r.trades[0]!.exitTimestamp, fixtureParams(data).to);
});
test("missing exit observation is never replaced by a fabricated fill", async () => {
  const data = changeQuotes(await historicalFixture(), 20000);
  const r = await replay({ ...data, optionQuotes: data.optionQuotes.filter(q => q.timestamp <= at(data, 49)) });
  assert.equal(r.totalTrades, 0); assert.equal(r.totalTraded, 1); assert.equal(r.status, "INCOMPLETE");
  assert.equal(r.unresolvedPositions.length, 1); assert.equal(r.finalCapital, r.initialCapital);
});
test("no exit occurs before its option evidence is available", async () => {
  const data = await historicalFixture();
  const r = await replay({ ...data, optionQuotes: data.optionQuotes.filter(q => q.timestamp !== at(data, 50)) });
  assert.equal(r.trades[0]!.exitTimestamp, at(data, 51)); assert.equal(r.status, "INCOMPLETE");
});
test("omitting the stop-time spot candle cannot turn a loss into a COMPLETE win", async () => {
  const data = await historicalFixture(), lossAt = at(data, 50);
  const tape = { ...data, optionQuotes: data.optionQuotes.map(q => q.timestamp === lossAt && q.instrumentToken === "100010"
    ? { ...q, bidMinor: 22900, askMinor: 23100, lastPriceMinor: 23000 } : q) };
  const complete = await replay(tape);
  assert.equal(complete.status, "COMPLETE"); assert.equal(complete.trades[0]!.exitReason, "STOP_HIT");
  assert.equal(complete.netPnL, -2600);
  const omitted = await replay({ ...tape, candles: tape.candles.filter((_, i) => i !== 50) });
  assert.equal(omitted.status, "INCOMPLETE");
  assert.equal(omitted.completeness.missingCandleCoverage, 1);
  assert.equal(omitted.trades[0]!.exitReason, "TARGET_HIT");
  assert.equal(omitted.trades[0]!.barsHeld, 2); // Declared replay bars, not compressed candle-array indexes.
});
test("multiple missing expected candles and a truncated requested horizon remain INCOMPLETE", async () => {
  const data = await historicalFixture();
  const gaps = await replay({ ...data, candles: data.candles.filter((_, i) => i !== 50 && i !== 51) });
  assert.equal(gaps.status, "INCOMPLETE"); assert.equal(gaps.completeness.missingCandleCoverage, 2);
  const truncated = await replay({ ...data, candles: data.candles.slice(0, 51),
    coverage: { ...data.coverage, coveredTo: at(data, 50), expectedCandleStarts: data.coverage.expectedCandleStarts.slice(0, 51) },
    optionQuotes: data.optionQuotes.filter(q => q.timestamp <= at(data, 50)) },
    { to: fixtureParams(data).to });
  assert.equal(truncated.status, "INCOMPLETE"); assert.equal(truncated.completeness.truncatedCoverage, true);
  assert.equal(truncated.completeness.missingCandleCoverage, 0);
  const undeclaredTruncation = await replay({ ...data, candles: data.candles.slice(0, 51) },
    { to: fixtureParams(data).to });
  assert.equal(undeclaredTruncation.status, "INCOMPLETE");
  assert.equal(undeclaredTruncation.completeness.missingCandleCoverage, 4);
});
test("provider-declared non-trading absence across a weekend is valid coverage", async () => {
  const data = await historicalFixture();
  const friday = Date.parse("2026-10-02T03:45:00.000Z"), monday = Date.parse("2026-10-05T03:45:00.000Z");
  const times = data.candles.map((_, i) => new Date((i < 50 ? friday + i * 300000
    : monday + (i - 50) * 300000)).toISOString());
  const documented = remapTimes(data, times);
  const result = await replay(documented, { from: at(documented, 49), to: at(documented, 54) });
  assert.equal(result.status, "COMPLETE"); assert.equal(result.completeness.missingCandleCoverage, 0);
});
test("a missing required hedge or short quote differs from a strategy hold", async () => {
  const data = await historicalFixture();
  for (const [token, reason] of [["100011", "NO_QUALIFIED_HEDGE"], ["100010", "NO_QUALIFIED_CONTRACT"]] as const) {
    const result = await replay({ ...data, optionQuotes: data.optionQuotes.filter(q => q.instrumentToken !== token) });
    assert.equal(result.status, "INCOMPLETE");
    assert.equal(result.decisions[0]!.strategyReason, reason);
    assert.ok(result.completeness.missingRequiredOptionObservations > 0);
    assert.equal(result.totalTrades, 0);
  }
});
test("a complete archived universe genuinely lacking the hedge remains a legitimate HOLD", async () => {
  const data = await historicalFixture();
  const csv = historicalCsv.split("\n").filter(line => !line.startsWith("100011,")).join("\n");
  const master = await new KiteInstrumentMasterService({ getInstrumentsCsv: async () => csv },
    () => new Date(data.master.provenance.retrievedAt),
    [{ underlying: "NIFTY", expiry: "2026-10-27", sourceReference: "OFFLINE_FIXTURE_CALENDAR" }]).load();
  const index = qualifyIndexMaster(csv, data.master.provenance.retrievedAt).resolve("NIFTY");
  const result = await replay({ ...data, master, index,
    optionQuotes: data.optionQuotes.filter(q => q.instrumentToken !== "100011")
      .map(q => ({ ...q, masterFingerprint: master.provenance.sourceFingerprint })) });
  assert.equal(result.decisions[0]!.strategyReason, "NO_QUALIFIED_HEDGE");
  assert.equal(result.status, "COMPLETE"); assert.equal(result.completeness.missingRequiredOptionObservations, 0);
});
test("an archive that does not attest its complete option universe cannot open a candidate", async () => {
  const data = await historicalFixture();
  const result = await replay({ ...data, coverage: { ...data.coverage, optionUniverseComplete: false } });
  assert.equal(result.status, "INCOMPLETE"); assert.equal(result.totalTraded, 0);
  assert.ok(result.completeness.incompleteContractUniverse > 0);
});
test("unusable historical Greek inputs are incomplete; ordinary quality holds remain complete", async () => {
  const data = await historicalFixture();
  const invalid = await replay({ ...data, optionQuotes: data.optionQuotes.map(q => ({ ...q, lastPriceMinor: 100000000 })) });
  assert.equal(invalid.decisions[0]!.strategyReason, "INVALID_GREEKS");
  assert.equal(invalid.status, "INCOMPLETE"); assert.ok(invalid.completeness.unavailableRequiredAnalytics > 0);
  const quality = await replay(data, { strategyConfig: { ...fixtureQuality, minConfidence: 0.9 } });
  assert.equal(quality.status, "COMPLETE"); assert.equal(quality.decisions[0]!.strategyReason, "CONFIDENCE_TOO_LOW");
});
test("the approved sub-hour expiry Greek model guard remains a fully evidenced HOLD", async () => {
  const data = await historicalFixture(70);
  const csv = historicalCsv.replace(/2026-10-06/g, "2026-09-29").replace(/NIFTY26O06/g, "NIFTY26929");
  const master = await new KiteInstrumentMasterService({ getInstrumentsCsv: async () => csv },
    () => new Date(data.master.provenance.retrievedAt),
    [{ underlying: "NIFTY", expiry: "2026-09-30", sourceReference: "OFFLINE_FIXTURE_CALENDAR" }]).load();
  const index = qualifyIndexMaster(csv, data.master.provenance.retrievedAt).resolve("NIFTY");
  const byToken = new Map(master.instruments.map(i => [i.instrumentToken, i]));
  const archive = { ...data, master, index, optionQuotes: data.optionQuotes.map(q => ({ ...q,
    canonicalId: byToken.get(q.instrumentToken)!.canonicalId,
    masterFingerprint: master.provenance.sourceFingerprint })) };
  const result = await replay(archive, { from: at(archive, 65),
    strategyConfig: { ...fixtureQuality, shortOffsetMinor: 13000 } });
  assert.equal(result.decisions[0]!.strategyReason, "INVALID_GREEKS");
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.completeness.unavailableRequiredAnalytics, 0);
});
test("missing spot bar is unavailable rather than a zero spot or synthetic fill", async () => {
  const data = await historicalFixture();
  const result = await replay({ ...data, candles: data.candles.filter((_, i) => i !== 49) },
    { from: fixtureParams(data).from });
  assert.equal(result.status, "INCOMPLETE"); assert.equal(result.completeness.missingCandleCoverage, 1);
  assert.ok(result.trades.every(t => t.entryTimestamp !== at(data, 49)));
});
test("directional stop uses the completed historical spot and entry ATR", async () => {
  const base = changeQuotes(await historicalFixture(), 20000);
  const data = { ...base, candles: base.candles.map((c, n) => n <= 49 ? c : { ...c,
    closeMinor: c.closeMinor - 20000, openMinor: c.openMinor - 20000, highMinor: c.highMinor - 20000, lowMinor: c.lowMinor - 20000 }) };
  const r = await replay(data, { directionalStopMult: 1 });
  assert.equal(r.trades[0]!.exitReason, "DIRECTIONAL_STOP");
});
for (const extreme of [100000, 200000]) test(`intrabar extremes ${extreme} cannot manufacture a favorable target fill`, async () => {
  const base = changeQuotes(await historicalFixture(), 20000);
  const data = { ...base, candles: base.candles.map((c, n) => n <= 49 ? c :
    { ...c, highMinor: c.highMinor + extreme, lowMinor: c.lowMinor - extreme }) };
  const r = await replay(data, { maxHoldingBars: 1 });
  assert.equal(r.trades[0]!.exitReason, "TIME_EXIT"); assert.ok(r.trades[0]!.pnl < 0);
  assert.equal(r.metadata.fillModelVersion, "CONTEMPORANEOUS_QUOTE_CLOSE_ONLY_V1");
});
for (const [minute, expected] of [[565, "OPENING_BLOCK"], [570, "CANDIDATE"]] as const)
  test(`opening boundary at IST minute ${minute}`, async () => {
    const data = await historicalFixture();
    const times = data.candles.map((c, n) => n < 49 ? c.timestamp.replace("2026-09-29", "2026-09-28")
      : new Date(Date.parse("2026-09-29T03:45:00Z") + (minute - 555 - 5 + (n - 49) * 5) * 60000).toISOString());
    const e = evaluation(remapTimes(data, times));
    assert.equal(e.result.action === "HOLD" ? e.result.reason : e.result.action, expected);
  });
for (const [cutoff, opened] of [[805, false], [806, true]] as const)
  test(`entry cutoff ${cutoff} is exclusive for new positions`, async () => {
    const r = await replay(await historicalFixture(), { entryCutoffMinute: cutoff });
    assert.equal(r.totalTraded > 0, opened);
  });
test("EOD boundary closes at the first available quote at configured IST time", async () => {
  const r = await replay(changeQuotes(await historicalFixture(), 20000), { entryCutoffMinute: 806, eodCloseMinute: 810 });
  assert.equal(r.trades[0]!.exitReason, "EOD_CLOSE"); assert.equal(r.trades[0]!.exitTimestamp, "2026-09-29T08:00:00.000Z");
});
test("same dataset/config produces byte-equivalent results with an explicit metadata timestamp", async () => {
  const data = await historicalFixture();
  assert.equal(JSON.stringify(await replay(data)), JSON.stringify(await replay(data)));
});
test("wall clock, random and run metadata cannot alter historical decisions", async () => {
  const data = await historicalFixture(), a = await replay(data);
  const now = Date.now, random = Math.random;
  try {
    Date.now = () => { throw new Error("wall clock decision"); };
    Math.random = () => { throw new Error("random decision"); };
    const b = await runHistoricalBacktest(fixtureParams(data), { provider: { load: async () => data }, runTimestamp: "2030-01-01T00:00:00.000Z" });
    assert.deepEqual(b.decisions, a.decisions); assert.deepEqual(b.trades, a.trades);
    assert.equal(b.metadata.runId, a.metadata.runId);
  } finally { Date.now = now; Math.random = random; }
});
test("date range is honored and all metrics reconcile to chronological trades and final equity", async () => {
  const data = await historicalFixture(), r = await replay(data), p = fixtureParams(data);
  assert.ok(r.decisions.every(d => d.evaluatedAt >= p.from && d.evaluatedAt <= p.to));
  assert.equal(r.netPnL, r.trades.reduce((n, t) => n + t.pnlMinor, 0) / 100);
  assert.equal(r.finalCapital, r.initialCapital + r.netPnL);
  assert.equal(r.equityCurve[r.equityCurve.length - 1]!.equity, r.finalCapital);
  assert.equal(r.totalSignals, r.totalTraded + r.totalBlocked);
  assert.equal(r.grossPnL - r.slippageCost, r.netPnL);
});
for (const patch of [{ from: "bad" }, { from: "2026-09-30T00:00:00Z" }, { interval: "day" },
  { to: "2027-09-30T00:00:00Z" }, { asset: "BTCUSD" }, { asset: "toString" }, { initialCapital: -1 },
  { initialCapital: Infinity }, { riskPerTradePct: 100 }, { riskPerTradePct: "2" },
  { maxHoldingBars: 1.5 }, { entryCutoffMinute: 931 }, { kiteAccessToken: "not-accepted" },
  { instrumentToken: "100010" }, { url: "http://example.invalid" }] as const)
  test(`invalid route/config rejects ${JSON.stringify(patch)}`, async () => {
    const data = await historicalFixture();
    assert.throws(() => normalizeBacktestParams({ ...fixtureParams(data), ...patch }), /INVALID_BACKTEST_CONFIG/);
  });
test("oversized dataset rejects before replay", async () => {
  const data = await historicalFixture();
  assert.throws(() => prepareReplay({ ...data, candles: Array(5001).fill(data.candles[0]) },
    normalizeBacktestParams(fixtureParams(data))), /INVALID_HISTORICAL_DATASET/);
});
test("weekends do not create synthetic trading sessions", async () => {
  const data = await historicalFixture();
  assert.throws(() => prepareReplay({ ...data, candles: data.candles.map(c => ({ ...c,
    timestamp: c.timestamp.replace("2026-09-29", "2026-09-27") })) }, normalizeBacktestParams(fixtureParams(data))), /CANDLE_OUTSIDE_NSE_SESSION/);
});
test("route is authenticated and missing archive returns explicit 503 without a fallback", async () => {
  const data = await historicalFixture();
  let status = 200, body: unknown;
  const res = { status(n: number) { status = n; return this; }, json(value: unknown) { body = value; return this; } };
  await createBacktestHandler()({ body: fixtureParams(data) } as any, res as any, () => { throw new Error("unexpected next"); });
  assert.equal(status, 503); assert.deepEqual(body, { error: "HISTORICAL_OPTION_ARCHIVE_NOT_CONFIGURED", code: "HISTORICAL_OPTION_ARCHIVE_NOT_CONFIGURED" });
  const router = createBacktestRouter();
  const route = (router as any).stack.find((layer: any) => layer.route?.path === "/run").route;
  route.stack[0].handle({ headers: {} }, res, () => { throw new Error("unauthorized route advanced"); });
  assert.equal(status, 401);
});
test("route rejects invalid fields before asking provider and returns the compatible result on valid input", async () => {
  const data = await historicalFixture(); let loads = 0, status = 200, body: any;
  const handler = createBacktestHandler({ load: async () => { loads++; return data; } });
  const res = { status(n: number) { status = n; return this; }, json(value: unknown) { body = value; return this; } };
  await handler({ body: { ...fixtureParams(data), interval: "year" } } as any, res as any, () => {});
  assert.equal(status, 400); assert.equal(loads, 0);
  await handler({ body: fixtureParams(data) } as any, res as any, () => {});
  assert.equal(loads, 1); assert.equal(body.netPnL, 1625); assert.equal(body.executionAuthority, "NONE");
});
test("replay imports no production financial or LLM execution service and makes zero network calls", async () => {
  await replay(await historicalFixture());
  const forbidden = /\/(?:RiskAdmissionService|OrderManager|PaperBroker|FillProcessor|CloseWorkflowService|SignalLoopService|LLMService)\.[jt]s$/;
  assert.deepEqual(Object.keys(require.cache).filter(file => forbidden.test(file)), []);
  const source = readFileSync(join(__dirname, "../../src/services/BacktestService.ts"), "utf8");
  assert.doesNotMatch(source, /from ["'].*models|fetchHistoricalOHLCV|computeSpreadDetails|computeAll\(/);
  assert.equal(networkCalls, 0);
});
