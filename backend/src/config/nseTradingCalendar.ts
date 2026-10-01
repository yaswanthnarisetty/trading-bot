/** NSE F&O notices verified 2026-09-30. Update this version for subsequent notices.
 * Trading holidays, not the clearing/settlement or currency-derivatives calendar. */
export const NSE_FO_CALENDAR_2026 = Object.freeze({
  kind: "NSE_FO_TRADING_CALENDAR_V1", version: "NSE_FO_2026_20260930_V1",
  timeZone: "Asia/Kolkata", coveredFrom: "2026-01-01", coveredTo: "2026-12-31",
  sourceReference: "NSE/FAOP/71777;NSE/FAOP/72262;NSE/FAOP/72352",
  sources: Object.freeze([
    "https://nsearchives.nseindia.com/content/circulars/FAOP71777.pdf",
    "https://nsearchives.nseindia.com/content/circulars/FAOP72262.pdf",
    "https://nsearchives.nseindia.com/content/circulars/FAOP72352.pdf",
  ]),
  holidays: Object.freeze({
    "2026-01-15": "Municipal Corporation Election in Maharashtra",
    "2026-01-26": "Republic Day", "2026-02-15": "Mahashivratri",
    "2026-03-03": "Holi", "2026-03-21": "Id-Ul-Fitr",
    "2026-03-26": "Shri Ram Navami", "2026-03-31": "Shri Mahavir Jayanti",
    "2026-04-03": "Good Friday", "2026-04-14": "Dr. Baba Saheb Ambedkar Jayanti",
    "2026-05-01": "Maharashtra Day", "2026-05-28": "Bakri Id", "2026-06-26": "Muharram",
    "2026-08-15": "Independence Day", "2026-09-14": "Ganesh Chaturthi",
    "2026-10-02": "Mahatma Gandhi Jayanti", "2026-10-20": "Dussehra",
    "2026-11-10": "Diwali-Balipratipada", "2026-11-24": "Prakash Gurpurb Sri Guru Nanak Dev",
    "2026-12-25": "Christmas",
  } as Readonly<Record<string, string>>),
  specialSessions: Object.freeze({
    "2026-02-01": Object.freeze({ description: "Union Budget", regularHours: true, source: "NSE/FAOP/72352" }),
    // The annual notice confirms the session but does not specify its timings.
    "2026-11-08": Object.freeze({ description: "Muhurat trading; timings not qualified", regularHours: false, source: "NSE/FAOP/71777" }),
  } as Readonly<Record<string, Readonly<{ description: string; regularHours: boolean; source: string }>>>),
});
