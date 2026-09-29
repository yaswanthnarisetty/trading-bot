import assert from "node:assert/strict";
import { familyFixture } from "./strategyFamilies";
import { fixtureParams, fixtureQuality } from "./historicalReplay";
import { evaluateHistoricalBar, normalizeBacktestParams, prepareReplay } from "../../src/domain/historicalReplay";
import type { StrategyFamily, TradeCandidate } from "../../src/domain/strategyEvaluation";
export async function financialCandidate(family: StrategyFamily = "DEBIT_VERTICAL", direction: "BULLISH" | "BEARISH" = "BULLISH", cheapCredit = false): Promise<TradeCandidate> {
  let data = await familyFixture();
  if (cheapCredit) data = { ...data, optionQuotes: data.optionQuotes.map(q => ({ ...q, bidMinor: q.bidMinor / 4, askMinor: q.askMinor / 4, lastPriceMinor: q.lastPriceMinor / 4 })) };
  const params = normalizeBacktestParams({ ...fixtureParams(data), strategyFamily: family, strategyConfig: fixtureQuality });
  const result = evaluateHistoricalBar(prepareReplay(data, params), 49, params, { version: "FINANCIAL_FIXTURE_V1",
    propose: () => ({ direction, confidence: 0.8, reason: "OFFLINE_FIXTURE" }) }).result;
  assert.equal(result.action, "CANDIDATE"); if (result.action !== "CANDIDATE") throw new Error("NO_CANDIDATE");
  return result.candidate;
}
export const financialFamilies = ["LONG_OPTION", "DEBIT_VERTICAL", "CREDIT_VERTICAL"] as const;
