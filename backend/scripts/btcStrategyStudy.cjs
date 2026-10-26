// Read-only, predeclared BTCUSD strategy study. Run from backend/ with ts-node/register and dotenv/config.
const { getDeltaDemoAccount, getDeltaDemoProduct } = require("../src/services/DeltaService");
const { BTC_RESEARCH_STRATEGIES, backtestBtcResearchStrategy,
  selectBtcResearchCandidate, btcHoldoutPasses } = require("../src/services/BtcStrategyResearchService");

const BASE = "https://cdn-ind.testnet.deltaex.org";
const DAYS = 90;
async function fetchBars(resolution, seconds, end, days = DAYS) {
  const start = end - days * 86400, intervalMs = seconds * 1000;
  const byTime = new Map();
  for (let from = start; from < end; from += seconds * 1600) {
    const until = Math.min(end, from + seconds * 1600);
    const query = new URLSearchParams({ symbol: "BTCUSD", resolution,
      start: String(from), end: String(until) });
    let body;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`${BASE}/v2/history/candles?${query}`, {
          headers: { Accept: "application/json", "User-Agent": "trading-bot-demo/1.0" },
          signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok) throw new Error(`DELTA_HISTORY_HTTP_${response.status}`);
        body = await response.json();
        if (body?.success !== true || !Array.isArray(body.result)) throw new Error("DELTA_HISTORY_INVALID");
        break;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    for (const raw of body.result) {
      const time = Number(raw.time) * 1000;
      if (time < start * 1000 || time >= end * 1000) continue;
      const bar = { timestamp: new Date(time), open: Number(raw.open), high: Number(raw.high),
        low: Number(raw.low), close: Number(raw.close), volume: Number(raw.volume) };
      if (!Number.isFinite(time) || time % intervalMs !== 0 ||
          ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
          bar.low <= 0 || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) ||
          bar.volume < 0) throw new Error("DELTA_HISTORY_MALFORMED_BAR");
      const old = byTime.get(time);
      if (old && JSON.stringify(old) !== JSON.stringify(bar)) throw new Error("DELTA_HISTORY_CONFLICTING_DUPLICATE");
      byTime.set(time, bar);
    }
  }
  const bars = [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
  const expected = days * 86400 / seconds;
  if (bars.length !== expected || bars[0]?.timestamp.getTime() !== start * 1000 ||
      bars.at(-1)?.timestamp.getTime() !== (end - seconds) * 1000 ||
      bars.some((bar, index) => index > 0 && bar.timestamp - bars[index - 1].timestamp !== intervalMs))
    throw new Error(`DELTA_HISTORY_GAPPED_${resolution}:${bars.length}/${expected}`);
  return bars;
}

async function run() {
  const [account, product] = await Promise.all([getDeltaDemoAccount(), getDeltaDemoProduct()]);
  const series = [];
  for (const [resolution, seconds] of [["5m", 300], ["15m", 900]]) {
    const end = Math.floor(Date.now() / (seconds * 1000)) * seconds;
    const bars = await fetchBars(resolution, seconds, end);
    series.push({ resolution, intervalMs: seconds * 1000, bars, trainEnd: Math.floor(bars.length * 0.5),
      validationEnd: Math.floor(bars.length * 0.75) });
  }
  const result = (strategy, study, startIndex, endIndex, costBpsRoundTrip) =>
    backtestBtcResearchStrategy({ bars: study.bars, product, strategy, startIndex, endIndex,
      intervalMs: study.intervalMs, startingEquityUsd: account.equity, costBpsRoundTrip });
  const candidates = BTC_RESEARCH_STRATEGIES.map(strategy => ({ strategy,
    train: series.map(study => result(strategy, study, 120, study.trainEnd, 30)),
    validation: series.map(study => result(strategy, study, study.trainEnd, study.validationEnd, 30)),
    zeroCostValidation: series.map(study => result(strategy, study, study.trainEnd, study.validationEnd, 0)),
  }));
  const selected = selectBtcResearchCandidate(candidates);
  const validationStress = selected ? series.map(study => result(selected, study,
    study.trainEnd, study.validationEnd, 60)) : [];
  const stressPassed = validationStress.length === 2 && validationStress.every(row =>
    row.trades >= 8 && row.netPnlUsd > 0 && row.maxDrawdownPct <= 5 &&
    row.profitFactor !== null && row.profitFactor >= 1.1);
  const holdout = selected && stressPassed ? series.flatMap(study => [30, 60].map(cost =>
    result(selected, study, study.validationEnd, study.bars.length, cost))) : [];
  const strategyValidated = selected !== null && stressPassed && btcHoldoutPasses(holdout);
  let higherTimeframe;
  try {
    const seconds = 3600, end = Math.floor(Date.now() / 3_600_000) * seconds;
    const bars = await fetchBars("1h", seconds, end, 180);
    const study = { resolution: "1h", intervalMs: 3_600_000, bars,
      trainEnd: Math.floor(bars.length * 0.5), validationEnd: Math.floor(bars.length * 0.75) };
    higherTimeframe = { sample: { bars: bars.length, from: bars[0].timestamp.toISOString(),
      to: bars.at(-1).timestamp.toISOString(), trainEnd: study.trainEnd,
      validationEnd: study.validationEnd },
    exploratoryOnly: true, candidates: BTC_RESEARCH_STRATEGIES.map(strategy => ({ strategy,
      train: result(strategy, study, 120, study.trainEnd, 30),
      validation: result(strategy, study, study.trainEnd, study.validationEnd, 30),
      zeroCostValidation: result(strategy, study, study.trainEnd, study.validationEnd, 0) })) };
  } catch (error) {
    higherTimeframe = { unavailable: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(JSON.stringify({ source: "Delta Demo BTCUSD", product,
    startingEquityUsd: account.equity, sample: series.map(study => ({ timeframe: study.resolution,
      bars: study.bars.length, from: study.bars[0].timestamp.toISOString(),
      to: study.bars.at(-1).timestamp.toISOString(), trainEnd: study.trainEnd,
      validationEnd: study.validationEnd })),
    methodology: "Predeclared strategies; 50% train / 25% validation / 25% untouched holdout; next-open entry, stop-first bars, gap-aware stops, 0.5% risk, 1x notional, 2% daily halt, 2 trades/day, 30/60bp round-trip cost",
    candidates, selected, validationStress, holdout, strategyValidated, higherTimeframe,
    automaticExecutionEnabled: false }, null, 2) + "\n");
}
run().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
