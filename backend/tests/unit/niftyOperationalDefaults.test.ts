import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AxiosInstance } from "axios";
import { NIFTY_OPERATIONAL_DEFAULTS as defaults, niftyMonthlyExpiries } from "../../src/config/niftyOperationalDefaults";
import { builtInNiftyPaperConfig } from "../../src/domain/paperMonitoring";
import { operationalEntryConfiguration, operationalExitConfigurations, operationalDefaultsStatus } from "../../src/services/PaperOperationalDefaults";
import { loadKiteOptionMaster, monthlyExpiryConfiguration } from "../../src/services/KiteMarketDataRuntime";
import { KiteSessionService } from "../../src/services/KiteSessionService";
import { kiteSession } from "../../src/services/KiteService";
import { createKiteRouter } from "../../src/routes/kite";
import type { KiteMarketDataService } from "../../src/services/KiteMarketDataService";
import { evaluatePaperReadiness } from "../../src/services/PaperDefaultSessionService";
import { classifyNseDate, nseLocalDate } from "../../src/domain/nseTradingCalendar";
const now = new Date("2026-10-01T05:00:00Z"), config = builtInNiftyPaperConfig("PAPER:NSE");
const csv = readFileSync(join(__dirname, "../fixtures/kite-instruments.csv"), "utf8");
const dirs: string[] = [];
async function file(value: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "nifty-defaults-")); dirs.push(dir);
  const path = join(dir, "config.json"); await writeFile(path, JSON.stringify(value)); return path;
}
after(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))); });

test("no-file NIFTY entry resolves a frozen, versioned model assumption without changing strategy/risk terms", async () => {
  const result = await operationalEntryConfiguration(config, now, {});
  assert.equal(result.riskFreeRate, 0.065); assert.equal(result.riskFreeRateVersion, defaults.greeks.riskFreeRateVersion);
  assert.deepEqual(result.strategyConfig, config.strategyConfig); assert.equal(result.accountId, "PAPER:NSE");
  assert.equal(result.dataMode, "KITE_REAL"); assert.equal(result.executionMode, "PAPER");
  assert.equal(result.calendar.version, classifyNseDate("2026-10-01").version); assert.ok(Object.isFrozen(result));
});
for (const change of [{ accountId: "PAPER:other" }, { asset: "BANKNIFTY" as const }, { dataMode: "MOCK" as const },
  { riskFreeRate: 0.05 }, { riskFreeRateVersion: "PARTIAL" }])
  test(`defaults do not invent assumptions for unsupported or partial configuration ${JSON.stringify(change)}`, async () => {
    await assert.rejects(operationalEntryConfiguration({ ...config, ...change }, now, {}), /GREEKS_CONFIG_REQUIRED/);
  });
test("valid explicit rate pair takes precedence", async () => {
  const path = await file({ riskFreeRate: 0.04, riskFreeRateVersion: "EXPLICIT_V2" });
  const result = await operationalEntryConfiguration(config, now, { NSE_PAPER_ENTRY_METADATA_FILE: path });
  assert.equal(result.riskFreeRate, 0.04); assert.equal(result.riskFreeRateVersion, "EXPLICIT_V2");
});
for (const value of [{}, { riskFreeRate: 0.04 }, { riskFreeRate: 99, riskFreeRateVersion: "BAD" },
  { riskFreeRate: "0.04", riskFreeRateVersion: "BAD" }, { riskFreeRate: 0.04, riskFreeRateVersion: "" }, { riskFreeRate: 0.04, source: "extra" }])
  test(`explicit invalid rate metadata never falls back ${JSON.stringify(value)}`, async () => {
    await assert.rejects(operationalEntryConfiguration(config, now, { NSE_PAPER_ENTRY_METADATA_FILE: await file(value) }), /GREEKS_CONFIG_REQUIRED|ENTRY_METADATA_INVALID/);
  });
test("unreadable file and conflicting calendar remain exact blockers", async () => {
  await assert.rejects(operationalEntryConfiguration(config, now, { NSE_PAPER_ENTRY_METADATA_FILE: "/nonexistent/nifty-config.json" }), /ENTRY_METADATA_INVALID/);
  await assert.rejects(operationalEntryConfiguration(config, now, { NSE_PAPER_ENTRY_METADATA_FILE: await file({
    riskFreeRate: 0.04, riskFreeRateVersion: "EXPLICIT", calendar: { version: "FORGED", sourceReference: "OTHER", openDates: ["2026-10-01"] },
  }) }), /CALENDAR_AUTHORITY_CONFLICT/);
});
test("monthly evidence uses last Tuesday and previous trading day on holidays", () => {
  const dates = niftyMonthlyExpiries(now).map(r => r.expiry);
  assert.deepEqual(dates, ["2026-01-27", "2026-02-24", "2026-03-30", "2026-04-28", "2026-05-26", "2026-06-30",
    "2026-07-28", "2026-08-25", "2026-09-29", "2026-10-27", "2026-11-23", "2026-12-29"]);
  assert.ok(niftyMonthlyExpiries(now).every(r => r.sourceReference.includes("NSE/FAOP/68747")));
});
test("coverage cannot silently roll into the next year", async () => {
  const outside = new Date("2027-01-04T05:00:00Z");
  await assert.rejects(operationalEntryConfiguration(config, outside, {}), /GREEKS_CONFIG_REQUIRED|CALENDAR_NOT_READY/);
  await assert.rejects(monthlyExpiryConfiguration(outside, {}), /MONTHLY_METADATA_REQUIRED/);
});
test("runtime master wiring qualifies covered NIFTY only and preserves the full source fingerprint", async () => {
  const result = await loadKiteOptionMaster({ get: async () => csv }, () => now, {});
  assert.ok(result.instruments.length); assert.ok(result.instruments.every(i => i.underlying === "NIFTY"));
  assert.equal(result.provenance.sourceFingerprint, createHash("sha256").update(csv).digest("hex"));
  assert.equal(result.provenance.qualificationScope?.coveredTo, "2026-12-31");
  assert.throws(() => result.resolveExpiry("BANKNIFTY", "2026-09-29"), /INSTRUMENT_NOT_FOUND/);
});
test("full dump may contain future contracts but those cannot be qualified outside coverage", async () => {
  const future = csv.split("\n")[1].replace("NIFTY26SEP25000CE", "NIFTY27JAN25000CE").replace("2026-09-29", "2027-01-26");
  const result = await loadKiteOptionMaster({ get: async () => csv.trimEnd() + "\n" + future }, () => now, {});
  assert.ok(!result.listExpiries("NIFTY").includes("2027-01-26"));
});
test("monthly/weekly contradictions inside coverage still invalidate the master", async () => {
  for (const text of [csv.replace("2026-09-29", "2026-09-28"), csv.replace("NIFTY26SEP25000CE", "NIFTY2692925000CE")])
    await assert.rejects(loadKiteOptionMaster({ get: async () => text }, () => now, {}), /INSTRUMENT_MASTER_STALE/);
});
for (const value of [[], {}, [{ underlying: "NIFTY", expiry: "2026-02-30", sourceReference: "bad" }],
  [{ underlying: "NIFTY", expiry: "2026-10-27", sourceReference: "" }]])
  test(`bad explicit monthly metadata cannot trigger a network read ${JSON.stringify(value)}`, async () => {
    let calls = 0;
    await assert.rejects(loadKiteOptionMaster({ get: async () => { calls++; return csv; } }, () => now,
      { KITE_MONTHLY_EXPIRIES_FILE: await file(value) }), /MONTHLY_METADATA_REQUIRED/);
    assert.equal(calls, 0);
  });
test("missing and conflicting explicit monthly evidence fail closed", async () => {
  const record = { underlying: "NIFTY", expiry: "2026-10-27", sourceReference: "EXPLICIT" };
  await assert.rejects(monthlyExpiryConfiguration(now, { KITE_MONTHLY_EXPIRIES_FILE: await file([record, { ...record, expiry: "2026-10-26" }]) }), /MONTHLY_METADATA_REQUIRED/);
  await assert.rejects(loadKiteOptionMaster({ get: async () => csv }, () => now, { KITE_MONTHLY_EXPIRIES_FILE: await file([record]) }), /MONTHLY_METADATA_REQUIRED/);
});
test("default exit policy is bounded to canonical NIFTY LONG_OPTION and validated", async () => {
  assert.deepEqual(await operationalExitConfigurations({}), [defaults.exitPolicy]);
  assert.equal(defaults.exitPolicy.underlying, "NIFTY"); assert.equal(defaults.exitPolicy.family, "LONG_OPTION");
  assert.equal(defaults.exitPolicy.stopLossBps, 5000); assert.equal(defaults.exitPolicy.eodMinuteIST, 920);
  assert.ok(Object.isFrozen(defaults.exitPolicy));
  const override = { ...defaults.exitPolicy, takeProfitBps: 4000 };
  assert.deepEqual(await operationalExitConfigurations({ NSE_PAPER_EXIT_CONFIG_FILE: await file([override]) }), [override]);
  for (const bad of [[{ ...override, stopLossBps: 0 }], [override, override], [{ ...override, executionMode: "LIVE" }]])
    await assert.rejects(operationalExitConfigurations({ NSE_PAPER_EXIT_CONFIG_FILE: await file(bad) }), /EXIT_CONFIG_REQUIRED/);
  assert.deepEqual(await operationalExitConfigurations({ NSE_PAPER_EXIT_CONFIG_FILE: await file([]) }), []);
});
test("status exposes assumptions, upcoming dates and policy without claiming readiness", async () => {
  const result = await operationalDefaultsStatus(config, now, {});
  assert.equal(result.greeks.status, "VALID"); assert.equal(result.greeks.value?.source, "BACKEND_FIXED_MODEL_ASSUMPTION_NOT_LIVE_RATE");
  assert.deepEqual(result.monthlyExpiry.value?.upcoming, ["2026-10-27", "2026-11-23", "2026-12-29"]);
  assert.equal(result.exitPolicy.value?.policyId, "NIFTY_LONG_OPTION_EXITS_V1"); assert.equal("entryReady" in result, false);
  const bad = await operationalDefaultsStatus(config, now, { NSE_PAPER_EXIT_CONFIG_FILE: await file([]) });
  assert.equal(bad.exitPolicy.reason, "EXIT_CONFIG_REQUIRED");
});
for (const reason of ["RECOVERY_REQUIRED", "RECONCILIATION_REQUIRED", "RECONCILIATION_NOT_MATCHED", "KILL_SWITCH_ACTIVE", "DAILY_LOSS_LIMIT_EXCEEDED", "RISK_POLICY_REQUIRED", "STALE_MARKET_DATA"])
  test(`operational defaults preserve ${reason}`, async () => {
    const result = await evaluatePaperReadiness({ sessionId: "test", config }, {
      clock: () => now, active: async () => ({}), connected: () => true, mode: () => "KITE_REAL",
      calendar: at => classifyNseDate(nseLocalDate(at)), entryConfig: c => operationalEntryConfiguration(c, now, {}),
      accountGate: async () => {}, assertReady: async () => { if (reason !== "STALE_MARKET_DATA") throw new Error(reason); },
      recover: async () => { throw new Error("UNEXPECTED_RECOVERY"); }, market: async () => { throw new Error(reason); },
    });
    assert.equal(result.entryReady, false); assert.equal(result.entryBlockingReason, reason);
  });
test("MOCK requires explicit internal fixture injection; singleton remains KITE_REAL", () => {
  assert.equal(kiteSession.getMode(), "KITE_REAL"); assert.throws(() => kiteSession.setMode("MOCK"), /DATA_MODE_REQUIRED/);
  const client = {} as Pick<AxiosInstance, "get" | "post">, credentials = () => ({ apiKey: "", apiSecret: "" });
  assert.throws(() => new KiteSessionService(client, credentials, Date.now, undefined, "MOCK"), /DATA_MODE_REQUIRED/);
  const fixture = new KiteSessionService(client, credentials, Date.now, undefined, "MOCK", true);
  assert.equal(fixture.getMode(), "MOCK"); fixture.setMode("KITE_REAL"); fixture.setMode("MOCK");
  assert.equal(fixture.getMode(), "MOCK");
});
test("production configuration loader rejects MOCK but retains complete KITE_REAL overrides", async () => {
  const { paperConfigurations } = await import("../../src/services/PaperOrchestrationRuntime");
  const previous = process.env.NSE_PAPER_CONFIG_FILE;
  try {
    const complete = await operationalEntryConfiguration(config, now, {});
    process.env.NSE_PAPER_CONFIG_FILE = await file([{ ...complete, dataMode: "MOCK" }]);
    await assert.rejects(paperConfigurations(), /INVALID_PAPER_CONFIG/);
    process.env.NSE_PAPER_CONFIG_FILE = await file([complete]);
    assert.deepEqual(await paperConfigurations(), [complete]);
  } finally {
    if (previous === undefined) delete process.env.NSE_PAPER_CONFIG_FILE;
    else process.env.NSE_PAPER_CONFIG_FILE = previous;
  }
});
test("public data-mode endpoint rejects MOCK even when an internal fixture is injected", async () => {
  const fixture = new KiteSessionService({} as Pick<AxiosInstance, "get" | "post">, () => ({ apiKey: "", apiSecret: "" }), Date.now, undefined, "KITE_REAL", true);
  const router = createKiteRouter(fixture, {} as KiteMarketDataService);
  const handler = (router as any).stack.find((s: any) => s.route?.path === "/data-mode").route.stack[0].handle;
  for (const mode of ["MOCK", "LIVE", undefined]) {
    let status = 0, body: any;
    await handler({ body: { dataMode: mode } }, { status(code: number) { status = code; return this; }, json(value: unknown) { body = value; } });
    assert.equal(status, 400); assert.equal(body.error, "DATA_MODE_REQUIRED"); assert.equal(fixture.getMode(), "KITE_REAL");
  }
  let body: any; await handler({ body: { dataMode: "KITE_REAL" } }, { json(value: unknown) { body = value; } });
  assert.deepEqual(body, { dataMode: "KITE_REAL" });
});
