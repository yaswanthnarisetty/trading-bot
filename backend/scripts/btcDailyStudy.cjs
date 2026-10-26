// Read-only Delta Demo BTCUSD daily-candle study. No order endpoint is called.
// Run from backend/: node -r ts-node/register -r dotenv/config scripts/btcDailyStudy.cjs
const { getDeltaDemoAccount, getDeltaDemoProduct } = require("../src/services/DeltaService");
const { backtestBtcDailyBreakout } = require("../src/services/BtcDailyResearchService");

const BASE = "https://cdn-ind.testnet.deltaex.org";
const DAY_SECONDS = 86_400;
const DAYS = 730;
const MIN_RESEARCH_DAYS = DAYS;

async function fetchDailyBars() {
  const end = Math.floor(Date.now() / (DAY_SECONDS * 1000)) * DAY_SECONDS;
  const start = end - DAYS * DAY_SECONDS;
  const query = new URLSearchParams({ symbol: "BTCUSD", resolution: "1d",
    start: String(start), end: String(end) });
  const response = await fetch(`${BASE}/v2/history/candles?${query}`, {
    headers: { Accept: "application/json", "User-Agent": "trading-bot-demo/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`DELTA_DAILY_HISTORY_HTTP_${response.status}`);
  const body = await response.json();
  if (body?.success !== true || !Array.isArray(body.result)) throw new Error("DELTA_DAILY_HISTORY_INVALID");
  const byTime = new Map();
  for (const raw of body.result) {
    const time = Number(raw.time) * 1000;
    if (time < start * 1000 || time >= end * 1000) continue;
    const bar = { timestamp: new Date(time), open: Number(raw.open), high: Number(raw.high),
      low: Number(raw.low), close: Number(raw.close), volume: Number(raw.volume) };
    if (!Number.isFinite(time) || time % (DAY_SECONDS * 1000) !== 0 ||
        ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
        bar.open <= 0 || bar.close <= 0 || bar.low <= 0 ||
        bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) ||
        bar.volume < 0) throw new Error("DELTA_DAILY_HISTORY_MALFORMED_BAR");
    const previous = byTime.get(time);
    if (previous && JSON.stringify(previous) !== JSON.stringify(bar))
      throw new Error("DELTA_DAILY_HISTORY_CONFLICTING_DUPLICATE");
    byTime.set(time, bar);
  }
  const bars = [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
  if (bars.length < 120 || bars.length > DAYS ||
      bars.at(-1)?.timestamp.getTime() !== (end - DAY_SECONDS) * 1000 ||
      bars.some((bar, index) => index > 0 &&
        bar.timestamp - bars[index - 1].timestamp !== DAY_SECONDS * 1000))
    throw new Error(`DELTA_DAILY_HISTORY_GAPPED_OR_TOO_SHORT:${bars.length}/${DAYS}`);
  return bars;
}

function passes(result) {
  return result.trades >= 8 && result.netPnlUsd > 0 &&
    result.profitFactor !== null && result.profitFactor >= 1.2 &&
    result.maxDrawdownPct <= 5;
}

async function run() {
  const [account, product, bars] = await Promise.all([
    getDeltaDemoAccount(), getDeltaDemoProduct(), fetchDailyBars(),
  ]);
  const trainEnd = Math.floor(bars.length * 0.5);
  const validationEnd = Math.floor(bars.length * 0.75);
  const evaluate = (startIndex, endIndex, costBpsRoundTrip) => backtestBtcDailyBreakout({
    bars, product, startIndex, endIndex, startingEquityUsd: account.equity, costBpsRoundTrip,
  });
  const training = [30, 60].map(cost => evaluate(60, trainEnd, cost));
  const validation = [30, 60].map(cost => evaluate(trainEnd, validationEnd, cost));
  const enoughHistory = bars.length >= MIN_RESEARCH_DAYS;
  const qualifiedForHoldout = enoughHistory && [...training, ...validation].every(passes);
  const holdout = qualifiedForHoldout
    ? [30, 60].map(cost => evaluate(validationEnd, bars.length, cost)) : [];
  const passedStudy = qualifiedForHoldout && holdout.every(passes);
  process.stdout.write(JSON.stringify({ source: "Delta Demo BTCUSD 1d closed candles",
    sample: { requestedDays: DAYS, minimumResearchDays: MIN_RESEARCH_DAYS,
      bars: bars.length, from: bars[0].timestamp.toISOString(),
      to: bars.at(-1).timestamp.toISOString(), trainEnd, validationEnd },
    accountEquityUsd: account.equity, product,
    method: "Fixed 20-day breakout + EMA20/50; next UTC daily open; prior-day high/low stop plus 0.1 ATR; 2R target; five-day maximum hold; one new trade/day; 0.5% estimated stop loss; 1x notional; three-day pause after three losses; stop-first/gap-aware fills; 30/60 bp estimated round-trip costs",
    training, validation, qualifiedForHoldout, holdout, passedStudy,
    qualificationBlockers: [
      ...(!enoughHistory ? ["INSUFFICIENT_DEMO_DAILY_HISTORY"] : []),
      ...(![...training, ...validation].every(passes) ? ["TRAINING_OR_VALIDATION_FAILED"] : []),
    ],
    automaticExecutionEnabled: false,
    note: "Read-only research. Even a passing study would not enable orders: broker stops, live signal parity and forward Demo performance need separate verification.",
  }, null, 2) + "\n");
}

run().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
