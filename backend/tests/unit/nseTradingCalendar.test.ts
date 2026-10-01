import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyNseDate, nseLocalDate, nsePaperCalendar, nseCalendarBlock } from "../../src/domain/nseTradingCalendar";
import { builtInNiftyPaperConfig, completeOperationalPaperEntryConfig } from "../../src/domain/paperMonitoring";
import { entryCalendarBlock } from "../../src/domain/paperOrchestration";
import { evaluatePaperReadiness, PaperDefaultSessionService } from "../../src/services/PaperDefaultSessionService";
const at = new Date("2026-09-30T05:00:00Z"), config = builtInNiftyPaperConfig("PAPER:NSE");
const rate = { riskFreeRate: 0.065, riskFreeRateVersion: "OFFLINE_EXPLICIT_RATE" };
for (const [date, expected] of [
  ["2026-09-30", "OPEN"], ["2026-01-15", "CLOSED_HOLIDAY"], ["2026-09-14", "CLOSED_HOLIDAY"],
  ["2026-10-02", "CLOSED_HOLIDAY"], ["2026-09-26", "CLOSED_WEEKEND"], ["2026-09-27", "CLOSED_WEEKEND"],
  ["2027-01-04", "UNAVAILABLE"], ["2025-12-31", "UNAVAILABLE"], ["2026-02-30", "UNAVAILABLE"],
  ["2026-02-26", "OPEN"], ["2026-04-02", "OPEN"],
]) test(`official NSE calendar ${date} is ${expected}`, () => assert.equal(classifyNseDate(date).status, expected));
test("IST local date and classification are independent of the host timezone", () => {
  assert.equal(nseLocalDate(new Date("2026-10-01T18:29:59Z")), "2026-10-01");
  assert.equal(nseLocalDate(new Date("2026-10-01T18:30:00Z")), "2026-10-02");
  assert.equal(classifyNseDate(nseLocalDate(new Date("2026-10-01T18:30:00Z"))).status, "CLOSED_HOLIDAY");
});
test("special sessions retain explicit source and timing support, never weekday inference", () => {
  const budget = classifyNseDate("2026-02-01"), muhurat = classifyNseDate("2026-11-08");
  assert.equal(budget.status, "SPECIAL_SESSION"); assert.equal(nseCalendarBlock(budget), null);
  assert.equal(muhurat.status, "SPECIAL_SESSION"); assert.equal(nseCalendarBlock(muhurat), "SPECIAL_SESSION_NOT_SUPPORTED");
  const full = completeOperationalPaperEntryConfig(config, rate, at);
  assert.equal(entryCalendarBlock(full, new Date("2026-02-01T05:00:00Z")), null);
  assert.equal(entryCalendarBlock(full, new Date("2026-11-08T05:00:00Z")), "SPECIAL_SESSION_NOT_SUPPORTED");
});
test("calendar adapter retains source/version and bounded coverage without daily openDates input", () => {
  const evidence = classifyNseDate("2026-09-30"), full = completeOperationalPaperEntryConfig(config, rate, at);
  assert.equal(evidence.timeZone, "Asia/Kolkata"); assert.equal(evidence.coveredTo, "2026-12-31");
  assert.ok(evidence.sources.every(s => s.startsWith("https://nsearchives.nseindia.com/")));
  assert.deepEqual(full.calendar, nsePaperCalendar(at)); assert.ok(full.calendar.openDates.includes("2026-09-30"));
  assert.equal(full.calendar.version, evidence.version);
  assert.equal(entryCalendarBlock(full, new Date("2027-01-04T05:00:00Z")), "CALENDAR_NOT_READY");
  assert.throws(() => nsePaperCalendar(new Date("2027-01-04T05:00:00Z")), /CALENDAR_NOT_READY/);
});
test("automatic calendar never defaults the explicit rate or merges conflicting authorities", () => {
  assert.throws(() => completeOperationalPaperEntryConfig(config, {}, at), /GREEKS_CONFIG_REQUIRED/);
  assert.throws(() => completeOperationalPaperEntryConfig(config, { ...rate,
    calendar: { version: "OTHER", sourceReference: "OTHER", openDates: ["2026-09-30"] } }, at), /CALENDAR_AUTHORITY_CONFLICT/);
});
for (const date of ["2026-10-02", "2026-09-27", "2027-01-04"]) test(`monitoring RUNNING on ${date} cannot prepare or enter`, async () => {
  let calls = 0;
  const now = new Date(`${date}T05:00:00Z`), session = { sessionId: "one", config, status: "RUNNING" };
  const service = new PaperDefaultSessionService({ configurations: async () => [], hasExplicitConfiguration: () => false,
    accounts: async () => [{ accountId: "PAPER:NSE" }], start: async () => session, sessionId: s => s.sessionId, schedule: () => {},
    readiness: s => evaluatePaperReadiness(s, { clock: () => now, active: async () => s, connected: () => true, mode: () => "KITE_REAL",
      calendar: time => classifyNseDate(nseLocalDate(time)), entryConfig: async c => completeOperationalPaperEntryConfig(c, rate, now),
      accountGate: async () => {}, assertReady: async () => {}, recover: async () => { calls++; return { status: "READY" }; }, market: async () => { calls++; } }, true) });
  const result = await service.start("NIFTY"); assert.equal(result.status, "RUNNING"); assert.equal(result.entryStatus, "WAITING");
  assert.equal(result.entryBlockingReason, date.startsWith("2027") ? "CALENDAR_NOT_READY" : "MARKET_CALENDAR_CLOSED"); assert.equal(calls, 0);
});
test("an official OPEN day proceeds to remaining config gates without inventing rate assumptions", async () => {
  const result = await evaluatePaperReadiness({ sessionId: "one", config }, { clock: () => at, active: async () => ({}),
    calendar: time => classifyNseDate(nseLocalDate(time)), connected: () => true, mode: () => "KITE_REAL",
    entryConfig: async c => completeOperationalPaperEntryConfig(c, {}, at), accountGate: async () => {}, assertReady: async () => {},
    recover: async () => ({ status: "READY" }), market: async () => {} }, true);
  assert.equal(result.calendar?.status, "OPEN"); assert.equal(result.entryBlockingReason, "GREEKS_CONFIG_REQUIRED");
  assert.equal(result.readinessAction, "OPERATOR_ACTION");
});
