import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { candidateEntryPlan } from "../../src/services/CandidateIntentAdapter";
import { projectDurablePaperPosition, projectPaperDecision } from "../../src/services/PaperDashboardReadService";
import { financialCandidate } from "../fixtures/financialCandidates";
import type { StrategyFamily } from "../../src/domain/strategyEvaluation";

const originals = { request: http.request, get: http.get, secureRequest: https.request, secureGet: https.get, fetch: globalThis.fetch };
let attempts = 0;
const block = () => { attempts++; throw new Error("EXTERNAL_HTTP_FORBIDDEN"); };

async function fixture(family: StrategyFamily) {
  const candidate = await financialCandidate(family), now = new Date(candidate.evaluatedAt);
  const { plan, targets } = candidateEntryPlan(candidate, new Date(+now + 60000), now);
  const position = { accountId: "PAPER:test-account", executionMode: "PAPER", positionId: "position-1", sessionId: "session-1",
    entryIntentId: "entry-1", lifecycle: "OPEN", integrity: "CONSISTENT", closureEvidenceRefs: [],
    activeCloseIntentId: null, realizedPnlMinor: 0,
    legs: targets.map(t => ({ legId: t.legId, contractKey: t.contractKey, entrySide: t.side,
      entryFilledUnits: t.targetUnits, exitFilledUnits: 0 })) };
  const fills = targets.map((t, i) => ({ fillId: `fill-${i}`, accountId: position.accountId, executionMode: "PAPER", broker: "PAPER",
    positionId: position.positionId, intentId: position.entryIntentId, legId: t.legId, contractKey: t.contractKey,
    side: t.side, quantityUnits: t.targetUnits, priceMinor: 12345 + i, executedAt: now }));
  return { plan, position, fills };
}

test("zero-fill PENDING_ENTRY is absent from open positions", async () => {
  const f = await fixture("LONG_OPTION");
  assert.equal(projectDurablePaperPosition({ ...f.position, lifecycle: "PENDING_ENTRY",
    legs: f.position.legs.map(l => ({ ...l, entryFilledUnits: 0 })) }, f.plan, [], null, []), null);
});
for (const family of ["LONG_OPTION", "DEBIT_VERTICAL", "CREDIT_VERTICAL"] as const)
  test(`${family} renders only actual fill-backed legs, units, entry price and kind`, async () => {
    const f = await fixture(family);
    const row = projectDurablePaperPosition(f.position, f.plan, f.fills, null, []);
    assert.ok(row); assert.equal(row.family, family); assert.equal(row.underlying, "NIFTY");
    assert.equal(row.strategyKind, f.plan.strategyKind); assert.equal(row.legs.length, family === "LONG_OPTION" ? 1 : 2);
    assert.ok(row.legs.every(l => l.entryPriceEvidence === "FILL_BACKED" && l.filledUnits === 65 && l.entryNotionalMinor !== null));
    assert.equal(row.openedAt, new Date(f.fills[0]!.executedAt).toISOString());
  });
test("stranded vertical shows its one actual long leg and an attention state", async () => {
  const f = await fixture("CREDIT_VERTICAL");
  const short = f.position.legs.find(l => l.entrySide === "SELL")!;
  short.entryFilledUnits = 0;
  const row = projectDurablePaperPosition(f.position, f.plan, f.fills.filter(fill => fill.side === "BUY"), null, []);
  assert.ok(row); assert.equal(row.legs.length, 1); assert.equal(row.legs[0]!.entrySide, "BUY");
  assert.equal(row.stranded, true); assert.equal(row.attention, true);
});
test("UNKNOWN and mismatched fill quantity show attention, never a fabricated average", async () => {
  const f = await fixture("LONG_OPTION");
  const row = projectDurablePaperPosition(f.position, f.plan, [{ ...f.fills[0], quantityUnits: 1 }],
    { status: "ATTENTION", reason: "ORDER_TRUTH_REQUIRED" }, [{ knowledge: "UNKNOWN" }]);
  assert.ok(row); assert.equal(row.legs[0]!.entryNotionalMinor, null); assert.equal(row.unknownOrder, true);
  assert.equal(row.attention, true); assert.equal(row.exitAttentionReason, "ORDER_TRUTH_REQUIRED");
});
test("CLOSED is shown only with durable closure evidence", async () => {
  const f = await fixture("LONG_OPTION");
  const unproven = projectDurablePaperPosition({ ...f.position, lifecycle: "CLOSED" }, f.plan, f.fills, null, []);
  assert.equal(unproven?.lifecycle, "ATTENTION"); assert.equal(unproven?.closeState, "ATTENTION");
  const proven = projectDurablePaperPosition({ ...f.position, lifecycle: "CLOSED", closureEvidenceRefs: ["proof"] }, f.plan, f.fills, null, []);
  assert.equal(proven?.lifecycle, "CLOSED"); assert.equal(proven?.closeState, "PROVEN_CLOSED");
});
for (const [outcome, candidate, reason] of [["HOLD", false, "OPENING_BLOCK"], ["DECIDED", true, "CANDIDATE"],
  ["REJECTED", true, "RISK_CAPACITY_EXCEEDED"], ["ENTRY", true, "ENTRY_FILLED_EXITS_DEFERRED"]] as const)
  test(`${outcome} remains a visible, distinct durable decision`, () => {
    const row = projectPaperDecision({ cycleId: `cycle-${outcome}`, timestamp: new Date("2026-09-29T04:30:00Z"),
      outcome, reason, config: { strategyConfig: { strategyFamily: "LONG_OPTION" } },
      decision: { finalProposal: { direction: "BULLISH", confidence: 0.7 },
        strategyResult: { action: candidate ? "CANDIDATE" : "HOLD", candidate: candidate ? { strategyKind: "LONG_CALL" } : undefined },
        primary: { status: "COMPLETED", result: { rationale: "Fixture rationale" } },
        verifier: { status: "COMPLETED", result: { verdict: "AGREE", reasonCode: "FIXTURE" } } } });
    assert.equal(row.outcome, outcome); assert.equal(row.candidate, candidate); assert.equal(row.reason, reason);
    assert.equal(row.verifier.verdict, "AGREE"); assert.equal(row.rationale, "Fixture rationale");
  });

test("dashboard projection tests make zero external HTTP calls", () => {
  assert.equal(attempts, 0);
});

// Network is blocked for the module's focused tests without affecting other files.
import { before, after } from "node:test";
before(() => { http.request = block as typeof http.request; http.get = block as typeof http.get;
  https.request = block as typeof https.request; https.get = block as typeof https.get; globalThis.fetch = block as typeof fetch; });
after(() => { http.request = originals.request; http.get = originals.get;
  https.request = originals.secureRequest; https.get = originals.secureGet; globalThis.fetch = originals.fetch;
  assert.equal(attempts, 0); });
