import { NSE_FO_CALENDAR_2026 as calendar } from "../config/nseTradingCalendar";
import { tradingDay } from "./realizedRisk";

export type NseCalendarStatus = "OPEN" | "CLOSED_WEEKEND" | "CLOSED_HOLIDAY" | "SPECIAL_SESSION" | "UNAVAILABLE";
export function nseLocalDate(now: Date): string {
  return tradingDay({ kind: "LOCAL_DATE_V1", timeZone: calendar.timeZone }, now);
}
export function classifyNseDate(localDate: string) {
  let status: NseCalendarStatus = "UNAVAILABLE", regularHours = false;
  let description = "Outside verified calendar coverage";
  const instant = new Date(`${localDate}T00:00:00.000Z`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(localDate) && Number.isFinite(+instant)
    && instant.toISOString().slice(0, 10) === localDate
    && localDate >= calendar.coveredFrom && localDate <= calendar.coveredTo) {
    const special = calendar.specialSessions[localDate];
    if (special) { status = "SPECIAL_SESSION"; regularHours = special.regularHours; description = special.description; }
    else if (calendar.holidays[localDate]) { status = "CLOSED_HOLIDAY"; description = calendar.holidays[localDate]; }
    else if ([0, 6].includes(instant.getUTCDay())) { status = "CLOSED_WEEKEND"; description = "Weekend"; }
    else { status = "OPEN"; regularHours = true; description = "Regular NSE F&O session"; }
  }
  return { localDate, status, regularHours, description, kind: calendar.kind, version: calendar.version,
    timeZone: calendar.timeZone, sourceReference: calendar.sourceReference, sources: [...calendar.sources],
    coveredFrom: calendar.coveredFrom, coveredTo: calendar.coveredTo };
}
export type NseCalendarEvidence = ReturnType<typeof classifyNseDate>;
export function nseCalendarBlock(evidence: NseCalendarEvidence): string | null {
  if (evidence.status === "UNAVAILABLE") return "CALENDAR_NOT_READY";
  if (evidence.status === "SPECIAL_SESSION" && !evidence.regularHours) return "SPECIAL_SESSION_NOT_SUPPORTED";
  return evidence.regularHours ? null : "MARKET_CALENDAR_CLOSED";
}
/** Adapter to the already-approved complete PaperSessionConfig; no new strategy calendar. */
export function nsePaperCalendar(now: Date) {
  if (classifyNseDate(nseLocalDate(now)).status === "UNAVAILABLE") throw new Error("CALENDAR_NOT_READY");
  const openDates: string[] = [];
  for (let at = Date.parse(`${calendar.coveredFrom}T00:00:00Z`); at <= Date.parse(`${calendar.coveredTo}T00:00:00Z`); at += 86400000) {
    const day = new Date(at).toISOString().slice(0, 10);
    if (classifyNseDate(day).regularHours) openDates.push(day);
  }
  return { version: calendar.version, sourceReference: calendar.sourceReference, openDates };
}
