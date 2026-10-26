/** Fixed PAPER-only allowance for a Kite option ask moving during admission.
 * The resulting limit is immutable and its full one-lot cost is reserved.
 */
export const KITE_PAPER_BUY_LIMIT_BUFFER_BPS = 100;

export function kitePaperBuyLimitMinor(askMinor: number, tickSizeMinor: number): number {
  if (!Number.isSafeInteger(askMinor) || askMinor <= 0 || !Number.isSafeInteger(tickSizeMinor) || tickSizeMinor <= 0)
    throw new Error("INVALID_RISK_ECONOMICS");
  const tick = BigInt(tickSizeMinor);
  const scaled = BigInt(askMinor) * BigInt(10_000 + KITE_PAPER_BUY_LIMIT_BUFFER_BPS);
  const limit = ((scaled + 10_000n * tick - 1n) / (10_000n * tick)) * tick;
  if (limit > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("RISK_ARITHMETIC_OVERFLOW");
  return Number(limit);
}
