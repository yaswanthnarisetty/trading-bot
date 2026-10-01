import { test } from "node:test";
import assert from "node:assert/strict";
import { capturePaperConfig } from "../../src/domain/paperOrchestration";
import { config as fixture } from "../fixtures/paperOrchestration";
import { defaultPaperSummary, parseDefaultStartRequest, PaperDefaultSessionService,
  resolveDefaultPaperConfig } from "../../src/services/PaperDefaultSessionService";

const base = () => capturePaperConfig({ ...fixture("LONG_OPTION"), dataMode: "KITE_REAL" });

test("NIFTY resolves one validated server-owned LONG_OPTION PAPER/KITE_REAL five-minute default", () => {
  const resolved = resolveDefaultPaperConfig("NIFTY", [base()]);
  const summary = defaultPaperSummary(resolved);
  assert.equal(summary.strategyFamily, "LONG_OPTION"); assert.equal(summary.executionMode, "PAPER");
  assert.equal(summary.dataMode, "KITE_REAL"); assert.equal(summary.intervalMs, 300000);
  assert.equal(summary.entryWindowStartMinuteIST, 570); assert.equal(summary.entryCutoffMinuteIST, 900);
  assert.equal(summary.minConfidence, 0.65);
  assert.deepEqual([summary.longOptionSelection.minAbsDelta, summary.longOptionSelection.maxAbsDelta], [0.55, 0.70]);
  assert.deepEqual(capturePaperConfig(resolved), resolved);
});
test("missing, duplicate, unsupported or altered production default fails closed", () => {
  assert.throws(() => resolveDefaultPaperConfig("BANKNIFTY", [base()]), /DEFAULT_PAPER_ASSET_UNAVAILABLE/);
  assert.throws(() => resolveDefaultPaperConfig("FINNIFTY", [base()]), /DEFAULT_PAPER_ASSET_UNAVAILABLE/);
  assert.throws(() => resolveDefaultPaperConfig("NIFTY", []), /DEFAULT_PAPER_CONFIG_REQUIRED/);
  assert.throws(() => resolveDefaultPaperConfig("NIFTY", [base(), base()]), /DEFAULT_PAPER_CONFIG_REQUIRED/);
  assert.throws(() => resolveDefaultPaperConfig("NIFTY", [capturePaperConfig({ ...base(), strategyConfig: { ...base().strategyConfig, strategyFamily: "CREDIT_VERTICAL" } })]), /DEFAULT_PAPER_CONFIG_REQUIRED/);
  assert.throws(() => resolveDefaultPaperConfig("NIFTY", [capturePaperConfig({ ...base(), intervalMs: 600000 })]), /DEFAULT_PAPER_CONFIG_INVALID/);
  assert.throws(() => capturePaperConfig({ ...base(), strategyConfig: { ...base().strategyConfig, strategyFamily: "AUTO" } }));
});
test("asset-only start request rejects browser-authored financial configuration and AUTO", () => {
  assert.equal(parseDefaultStartRequest({ asset: "NIFTY" }), "NIFTY");
  for (const body of [{ asset: "NIFTY", strategyFamily: "AUTO" }, { asset: "NIFTY", configId: "other" },
    { asset: "NIFTY", executionMode: "LIVE" }, null, { strategyFamily: "LONG_OPTION" }])
    assert.throws(() => parseDefaultStartRequest(body), /ASSET_ONLY_START_REQUIRED/);
});

function harness(overrides: Partial<{ connected: boolean; mode: string; active: boolean; recovery: string; gateError: string; startError: string }> = {}) {
  const calls: string[] = []; let resolveRecovery: (() => void) | undefined;
  const paused = new Promise<void>(resolve => { resolveRecovery = resolve; });
  const service = new PaperDefaultSessionService({
    configurations: async () => [base()], connected: () => overrides.connected !== false,
    dataMode: () => overrides.mode ?? "KITE_REAL",
    active: async () => { calls.push("active"); return overrides.active ? { sessionId: "session-1", accountId: base().accountId } : null; },
    recover: async () => { calls.push("recover"); await paused; return { status: overrides.recovery ?? "READY" }; },
    accountGate: async () => { calls.push("gate"); if (overrides.gateError) throw new Error(overrides.gateError); },
    start: async c => { calls.push("start"); if (overrides.startError) throw new Error(overrides.startError);
      return { sessionId: "session-1", accountId: c.accountId, config: c }; },
    schedule: () => { calls.push("schedule"); }, sessionId: s => s.sessionId,
  });
  return { service, calls, release: () => resolveRecovery?.() };
}
test("connected default Start prepares recovery then starts exactly one PAPER session and timer", async () => {
  const h = harness(); const pending = h.service.start("NIFTY"); h.release();
  const session = await pending;
  assert.equal(session.sessionId, "session-1");
  assert.deepEqual(h.calls, ["gate", "active", "recover", "start", "schedule"]);
});
test("rapid duplicate Start shares one recovery, one session and one timer", async () => {
  const h = harness(); const [first, second] = [h.service.start("NIFTY"), h.service.start("NIFTY")];
  await new Promise<void>(resolve => setImmediate(resolve)); h.release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].sessionId, results[1].sessionId);
  assert.equal(h.calls.filter(x => x === "recover").length, 1);
  assert.equal(h.calls.filter(x => x === "schedule").length, 1);
});
test("existing same-account session is reused without a second recovery", async () => {
  const h = harness({ active: true }); const session = await h.service.start("NIFTY");
  assert.equal(session.sessionId, "session-1"); assert.deepEqual(h.calls, ["gate", "active", "start", "schedule"]);
});
for (const [name, overrides, reason] of [
  ["missing Kite", { connected: false }, "KITE_SESSION_REQUIRED"],
  ["wrong data mode", { mode: "MOCK" }, "DATA_MODE_REQUIRED"],
  ["account/kill gate", { gateError: "KILL_SWITCH_ACTIVE" }, "KILL_SWITCH_ACTIVE"],
  ["reconciliation mismatch", { recovery: "MISMATCH" }, "RECONCILIATION_NOT_MATCHED"],
  ["reconciliation incomplete", { recovery: "INCOMPLETE" }, "RECONCILIATION_INCOMPLETE"],
  ["missing monthly metadata", { startError: "MONTHLY_METADATA_REQUIRED" }, "MONTHLY_METADATA_REQUIRED"],
] as const) test(`${name} blocks before scheduler activation`, async () => {
  const h = harness(overrides); const pending = h.service.start("NIFTY"); h.release();
  await assert.rejects(pending, new RegExp(reason)); assert.equal(h.calls.includes("schedule"), false);
});
