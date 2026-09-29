import { createHash } from "node:crypto";
import { assertMarketAnalytics, type MarketAnalyticsSnapshot } from "./marketAnalytics";

/** Canonical, versioned digest of the decision-relevant values in an issued analytics snapshot. */
export function analyticsEvidenceId(snapshot: MarketAnalyticsSnapshot): string {
  assertMarketAnalytics(snapshot);
  const evidence = {
    version: snapshot.version, underlying: snapshot.underlying, dataMode: snapshot.dataMode,
    source: snapshot.source, evaluatedAt: snapshot.evaluatedAt,
    spotMinor: snapshot.spotMinor, spotTimestamp: snapshot.spotTimestamp,
    indexCanonicalId: snapshot.indexCanonicalId, indexMasterFingerprint: snapshot.indexMasterFingerprint,
    optionMasterFingerprint: snapshot.optionMasterFingerprint, candleInterval: snapshot.candleInterval,
    indicators: snapshot.indicators,
    options: snapshot.options.map(option => ({
      canonicalId: option.canonicalId, instrumentToken: option.instrument.instrumentToken,
      exchange: option.instrument.exchange, expiry: option.instrument.expiry,
      strikeMinor: option.instrument.strikeMinor, instrumentType: option.instrument.instrumentType,
      lotSizeUnits: option.instrument.lotSizeUnits, bidMinor: option.bidMinor, askMinor: option.askMinor,
      bidQuantity: option.bidQuantity, askQuantity: option.askQuantity,
      priceTimestamp: option.priceTimestamp, optionTradeTimestamp: option.optionTradeTimestamp,
      greeks: option.greeks.available ? {
        available: true, version: option.greeks.value.version,
        valuationAt: option.greeks.value.valuationAt, expiryAt: option.greeks.value.expiryAt,
        expiryAssumptionVersion: option.greeks.value.expiryAssumptionVersion,
        riskFreeRate: option.greeks.value.riskFreeRate,
        riskFreeRateVersion: option.greeks.value.riskFreeRateVersion,
        optionPriceMinor: option.greeks.value.optionPriceMinor,
        impliedVolatility: option.greeks.value.impliedVolatility,
        delta: option.greeks.value.delta, gamma: option.greeks.value.gamma,
        thetaPerDay: option.greeks.value.thetaPerDay, vegaPerPercent: option.greeks.value.vegaPerPercent,
      } : { available: false, reason: option.greeks.reason },
    })).sort((a, b) => a.canonicalId < b.canonicalId ? -1 : a.canonicalId > b.canonicalId ? 1 : 0),
  };
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("ANALYTICS_UNAVAILABLE");
    return JSON.stringify(value);
  };
  return `ANALYTICS_SHA256_V1:${createHash("sha256").update(canonical(evidence)).digest("hex")}`;
}
