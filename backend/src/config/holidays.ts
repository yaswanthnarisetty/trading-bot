import { NSE_FO_CALENDAR_2026 } from "./nseTradingCalendar";

/**
 * NSE trading holidays for 2025.
 * The market hours guard checks this list before allowing session start.
 * Update this list at the start of each year.
 * Source: https://www.nseindia.com/resources/exchange-communication-holidays
 */
export const NSE_HOLIDAYS_2025: string[] = [
  "2025-01-26", // Republic Day
  "2025-02-26", // Mahashivratri
  "2025-03-14", // Holi
  "2025-03-31", // Id-Ul-Fitr (Ramzan Eid)
  "2025-04-10", // Shri Ram Navami
  "2025-04-14", // Dr. Baba Saheb Ambedkar Jayanti
  "2025-04-18", // Good Friday
  "2025-05-01", // Maharashtra Day
  "2025-08-15", // Independence Day
  "2025-08-27", // Ganesh Chaturthi
  "2025-10-02", // Mahatma Gandhi Jayanti
  "2025-10-02", // Dussehra
  "2025-10-21", // Diwali Laxmi Pujan
  "2025-10-22", // Diwali Balipratipada
  "2025-11-05", // Prakash Gurpurb Sri Guru Nanak Dev Ji
  "2025-12-25", // Christmas
];

/** Legacy helpers share the verified F&O closure dates. Special-session readiness
 * and coverage checks belong to domain/nseTradingCalendar. */
export const NSE_HOLIDAYS_2026: string[] = Object.keys(NSE_FO_CALENDAR_2026.holidays);

/**
 * Merged NSE holiday list covering 2025 and 2026.
 * All market-hours guards and expiry logic use this combined list.
 */
export const NSE_HOLIDAYS: string[] = [
  ...NSE_HOLIDAYS_2025,
  ...NSE_HOLIDAYS_2026,
];

