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

/**
 * NSE trading holidays for 2026.
 * All indices (NIFTY, BANKNIFTY, FINNIFTY) now expire on Tuesday as of Sep 1 2025.
 * If Tuesday is a holiday → expiry shifts to the previous trading day.
 * Key shifts:
 *   Mar 3 (Holi/Tue)  → NIFTY weekly + BANKNIFTY/FINNIFTY March monthly shift to Mar 2
 *   Mar 31 (Eid/Tue)  → NIFTY weekly + BANKNIFTY/FINNIFTY March monthly shift to Mar 30
 *   Oct 20 (Diwali/Tue) → expiry shifts to Oct 19
 *   Apr 14 (Ambedkar/Tue) → expiry shifts to Apr 13
 * Source: https://www.nseindia.com/resources/exchange-communication-holidays
 */
export const NSE_HOLIDAYS_2026: string[] = [
  "2026-01-26", // Republic Day (Monday)
  "2026-02-26", // Mahashivratri (Thursday)
  "2026-03-03", // Holi (Tuesday) ← NIFTY weekly + BANKNIFTY/FINNIFTY March monthly → Mar 2
  "2026-03-31", // Id-Ul-Fitr / Eid (Tuesday) ← NIFTY weekly + monthly → Mar 30
  "2026-04-02", // Ram Navami (Thursday)
  "2026-04-03", // Good Friday (Friday)
  "2026-04-14", // Dr. Baba Saheb Ambedkar Jayanti (Tuesday) ← expiry → Apr 13
  "2026-05-01", // Maharashtra Day (Friday)
  "2026-08-27", // Ganesh Chaturthi (Thursday)
  "2026-10-02", // Mahatma Gandhi Jayanti (Friday)
  "2026-10-20", // Diwali Laxmi Puja (Tuesday) ← expiry → Oct 19
  "2026-10-21", // Diwali Balipratipada (Wednesday)
  "2026-11-25", // Prakash Gurpurb Sri Guru Nanak Dev Ji (Wednesday)
  "2026-12-25", // Christmas (Friday)
];

/**
 * Merged NSE holiday list covering 2025 and 2026.
 * All market-hours guards and expiry logic use this combined list.
 */
export const NSE_HOLIDAYS: string[] = [
  ...NSE_HOLIDAYS_2025,
  ...NSE_HOLIDAYS_2026,
];

