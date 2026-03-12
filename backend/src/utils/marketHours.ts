import { toZonedTime, formatInTimeZone } from "date-fns-tz";
import {
  getDay,
  isAfter,
  isBefore,
  set,
  isEqual,
  addDays,
  differenceInCalendarDays,
} from "date-fns";
import { NSE_HOLIDAYS } from "../config/holidays";
import type { AssetKey } from "../config/assets";

const IST_TIMEZONE = "Asia/Kolkata";

/**
 * Gets the current time in the Asia/Kolkata timezone.
 */
function nowInIST(): Date {
  return toZonedTime(new Date(), IST_TIMEZONE);
}

/**
 * Determines whether a given IST date falls on an NSE trading holiday.
 */
function isHolidayIST(date: Date): boolean {
  const isoDate = formatInTimeZone(date, IST_TIMEZONE, "yyyy-MM-dd");
  return NSE_HOLIDAYS.includes(isoDate);
}

/**
 * Checks if the Indian cash and F&O markets are currently open.
 * Validates weekday, holiday calendar, and intraday time window (09:15–15:30 IST).
 *
 * @returns True if the current IST time is within regular NSE trading hours.
 */
export function isMarketOpen(): boolean {
  const now = nowInIST();
  const day = getDay(now); // 0=Sun, 1=Mon, ... 6=Sat

  if (day === 0 || day === 6) {
    return false;
  }

  if (isHolidayIST(now)) {
    return false;
  }

  const start = set(now, { hours: 9, minutes: 15, seconds: 0, milliseconds: 0 });
  const end = set(now, { hours: 15, minutes: 30, seconds: 0, milliseconds: 0 });

  return (isAfter(now, start) || isEqual(now, start)) &&
    (isBefore(now, end) || isEqual(now, end));
}

/**
 * Checks whether the current IST time is past the "no new positions" cutoff.
 * After 15:00 IST the system will not open fresh positions, only manage existing ones.
 *
 * @returns True if time is after 15:00 IST.
 */
export function isAfterCutoff(): boolean {
  const now = nowInIST();
  const cutoff = set(now, {
    hours: 15,
    minutes: 0,
    seconds: 0,
    milliseconds: 0,
  });
  return isAfter(now, cutoff);
}

/**
 * Checks whether it is the end-of-day close window for all positions.
 * On Tuesday (NIFTY expiry): force-close at 15:00 IST to avoid gamma risk.
 * On all other days: force-close at 15:20 IST.
 *
 * @returns True if the EOD close window has been reached.
 */
export function isEODClose(): boolean {
  const now = nowInIST();
  const dow = getDay(now); // 0=Sun, 2=Tue, 5=Fri, 6=Sat
  const h = now.getHours();
  const m = now.getMinutes();

  if (dow === 2) {
    // Tuesday — NIFTY weekly expiry; close by 15:00
    return h >= 15;
  }

  // All other days — 15:20 cutoff
  return h > 15 || (h === 15 && m >= 20);
}

/**
 * Determines whether the session loops should auto-stop for the trading day.
 * After 15:30 IST, no new ticks or position monitors should continue running.
 *
 * @returns True if time is after 15:30 IST.
 */
export function shouldAutoStop(): boolean {
  const now = nowInIST();
  const stopTime = set(now, {
    hours: 15,
    minutes: 30,
    seconds: 0,
    milliseconds: 0,
  });
  return isAfter(now, stopTime);
}

/**
 * Returns the upcoming Tuesday expiry for NIFTY (weekly).
 * Logic:
 *   Sun (0) or Mon (1) → this Tuesday
 *   Tue (2) → this Tuesday, unless market has closed (≥15:30), then next Tuesday
 *   Wed–Sat → next Tuesday
 * If the resolved Tuesday is a holiday, shift back to the nearest prior trading day.
 *
 * @param istDate - The reference IST date.
 * @returns IST Date of the effective NIFTY weekly expiry.
 */
function getNearestTuesdayExpiry(istDate: Date): Date {
  const dow = getDay(istDate); // 0=Sun ... 6=Sat
  let daysToTuesday: number;

  if (dow < 2) {
    // Sun or Mon — this coming Tuesday
    daysToTuesday = 2 - dow;
  } else if (dow === 2) {
    // Tuesday — use today unless market is closed for the day
    const closeTime = set(istDate, { hours: 15, minutes: 30, seconds: 0, milliseconds: 0 });
    daysToTuesday = isAfter(istDate, closeTime) ? 7 : 0;
  } else {
    // Wed–Sat — next Tuesday
    daysToTuesday = 9 - dow;
  }

  const startOfDay = set(istDate, { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 });
  let expiry = addDays(startOfDay, daysToTuesday);

  // Shift back if holiday or weekend
  while (isHolidayIST(expiry) || getDay(expiry) === 0 || getDay(expiry) === 6) {
    expiry = addDays(expiry, -1);
  }

  return expiry;
}

/**
 * Returns the last Tuesday of the current month for BANKNIFTY/FINNIFTY (monthly).
 * If that Tuesday is a holiday, shifts to the nearest prior trading day.
 * If today is already past the last Tuesday of this month, recurses to next month.
 *
 * @param istDate - The reference IST date.
 * @returns IST Date of the effective monthly expiry.
 */
function getLastTuesdayOfMonthExpiry(istDate: Date): Date {
  const year = istDate.getFullYear();
  const month = istDate.getMonth();

  // Start from the last day of the month
  let lastTuesday = new Date(year, month + 1, 0, 0, 0, 0, 0);

  // Walk back to the last Tuesday
  while (getDay(lastTuesday) !== 2) {
    lastTuesday = addDays(lastTuesday, -1);
  }

  // Shift back if the Tuesday is a holiday
  while (isHolidayIST(lastTuesday) || getDay(lastTuesday) === 0 || getDay(lastTuesday) === 6) {
    lastTuesday = addDays(lastTuesday, -1);
  }

  const startOfToday = set(istDate, { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 });
  const startOfExpiry = set(lastTuesday, { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 });

  // If we're already past this month's expiry, recurse to next month
  if (isAfter(startOfToday, startOfExpiry)) {
    return getLastTuesdayOfMonthExpiry(new Date(year, month + 1, 1));
  }

  return lastTuesday;
}

/**
 * Computes the effective upcoming expiry date for the given asset.
 * - NIFTY: weekly — nearest upcoming Tuesday
 * - BANKNIFTY, FINNIFTY: monthly — last Tuesday of the current month
 * Holiday shifts and weekend shifts applied in both cases.
 *
 * @param asset - The asset key (NIFTY, BANKNIFTY, FINNIFTY).
 * @param referenceDate - Optional UTC Date to use as "now" (defaults to current time).
 * @returns IST Date of the effective upcoming expiry.
 */
export function getWeeklyExpiryDate(asset: AssetKey, referenceDate?: Date): Date {
  const istDate = referenceDate ? toZonedTime(referenceDate, IST_TIMEZONE) : nowInIST();

  if (asset === "NIFTY") {
    return getNearestTuesdayExpiry(istDate);
  }

  // BANKNIFTY and FINNIFTY — monthly last Tuesday
  return getLastTuesdayOfMonthExpiry(istDate);
}

/**
 * Returns the effective upcoming expiry date as an IST-formatted string (yyyy-MM-dd).
 *
 * @param asset - The asset key.
 * @returns ISO date string of the effective expiry in IST.
 */
export function getWeeklyExpiryDateStr(asset: AssetKey): string {
  const expiry = getWeeklyExpiryDate(asset);
  return formatInTimeZone(expiry, IST_TIMEZONE, "yyyy-MM-dd");
}

/**
 * Computes days to expiry (DTE) from today in IST for the given asset.
 * Returns 0 on expiry day itself.
 *
 * @param asset - The asset key whose expiry to evaluate.
 * @param referenceDate - Optional UTC Date to use as "now" (defaults to current time).
 * @returns Number of calendar days from today IST to expiry (0 = expiry day).
 */
export function getDTE(asset: AssetKey, referenceDate?: Date): number {
  const istDate = referenceDate ? toZonedTime(referenceDate, IST_TIMEZONE) : nowInIST();
  const startOfToday = set(istDate, { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 });

  const expiry = getWeeklyExpiryDate(asset, referenceDate);
  const startOfExpiry = set(expiry, { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 });

  return Math.max(0, differenceInCalendarDays(startOfExpiry, startOfToday));
}

/**
 * Computes DTE to the NEXT expiry cycle beyond the current one.
 * For NIFTY (weekly): next week's Tuesday.
 * For BANKNIFTY/FINNIFTY (monthly): last Tuesday of next month.
 * Used to give LLM context about the upcoming cycle.
 *
 * @param asset - The asset key.
 * @returns Calendar days to the next cycle's expiry from today.
 */
export function getNextCycleDTE(asset: AssetKey): number {
  const currentExpiry = getWeeklyExpiryDate(asset);
  // Push one day past current expiry to get the next cycle's reference date
  const nextCycleRef = addDays(currentExpiry, 1);
  const nextExpiry = getWeeklyExpiryDate(asset, nextCycleRef);

  const istToday = nowInIST();
  const startOfToday = set(istToday, { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 });
  const startOfNextExpiry = set(nextExpiry, { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 });

  return Math.max(0, differenceInCalendarDays(startOfNextExpiry, startOfToday));
}

/**
 * Returns the day of week for the current IST time.
 * 0 = Sunday, 1 = Monday, 2 = Tuesday, ... 6 = Saturday
 *
 * @returns Integer day of week in IST.
 */
export function getISTDayOfWeek(): number {
  return getDay(nowInIST());
}

/**
 * Formats a given Date into an IST-localized time string.
 *
 * @param date - The Date to format.
 * @returns A string formatted as "HH:mm:ss IST".
 */
export function formatISTTime(date: Date): string {
  return formatInTimeZone(date, IST_TIMEZONE, "HH:mm:ss 'IST'");
}

/**
 * Determines whether today (IST) is the effective expiry day for the given asset.
 *
 * @param asset - Asset key to evaluate.
 * @returns True if today is the asset's effective expiry day.
 */
export function isExpiryDay(asset: AssetKey): boolean {
  return getDTE(asset) === 0;
}

/**
 * Returns true on Fridays after 14:00 IST.
 * Friday afternoon positions carry weekend gap risk that cannot be hedged.
 *
 * @returns True if the current IST time is Friday after 2 PM.
 */
export function isFridayGapRisk(): boolean {
  const now = nowInIST();
  if (getDay(now) !== 5) {
    return false;
  }
  const pm2 = set(now, { hours: 14, minutes: 0, seconds: 0, milliseconds: 0 });
  return isAfter(now, pm2);
}

/**
 * Returns true on the trading day immediately before an NSE holiday, after 14:00 IST.
 * Pre-holiday positions carry gap risk since markets are closed the following day.
 *
 * @returns True if tomorrow is an NSE holiday and current IST time is after 2 PM.
 */
export function isPreHolidayGapRisk(): boolean {
  const now = nowInIST();
  const tomorrow = addDays(now, 1);
  const tomorrowStr = formatInTimeZone(tomorrow, IST_TIMEZONE, "yyyy-MM-dd");
  if (!NSE_HOLIDAYS.includes(tomorrowStr)) {
    return false;
  }
  const pm2 = set(now, { hours: 14, minutes: 0, seconds: 0, milliseconds: 0 });
  return isAfter(now, pm2);
}
