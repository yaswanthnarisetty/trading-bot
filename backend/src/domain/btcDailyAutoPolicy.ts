const DAY_MS = 86_400_000;

/** Three most recently closed daily trades, newest first. Skip the next three UTC days. */
export function btcThreeLossCooldownActive(
  recent: readonly { realizedPnlUsd?: number | null; updatedAt?: Date }[], nowMs: number,
): boolean {
  if (!Number.isFinite(nowMs) || recent.length < 3 ||
      recent.slice(0, 3).some(trade => trade.realizedPnlUsd == null ||
        !Number.isFinite(trade.realizedPnlUsd) || trade.realizedPnlUsd > 0)) return false;
  const newestClose = recent[0]!.updatedAt?.getTime();
  if (newestClose === undefined || !Number.isFinite(newestClose)) return true;
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return today < Math.floor(newestClose / DAY_MS) * DAY_MS + 4 * DAY_MS;
}
