import { assertQualifiedInstrument, type InstrumentDefinition } from "../services/KiteInstrumentMasterService";
import { computeD1, computeD2, computeDelta, computeGamma, computeTheta, computeVega, normalCDF } from "../utils/greeksMath";
import { freeze, marketTimestamp } from "./kiteMarketData";

export interface QualifiedGreeks {
  readonly version: "QUALIFIED_BSM_IV_V1";
  readonly instrument: InstrumentDefinition;
  readonly canonicalId: string;
  readonly dataMode: "KITE_REAL" | "MOCK";
  readonly source: "KITE" | "MOCK";
  readonly masterFingerprint: string;
  readonly valuationAt: string;
  readonly optionPriceTimestamp: string | null;
  readonly expiryAt: string;
  readonly expiryAssumptionVersion: string;
  readonly riskFreeRate: number;
  readonly riskFreeRateVersion: string;
  readonly spotMinor: number;
  readonly optionPriceMinor: number;
  readonly impliedVolatility: number;
  readonly delta: number;
  readonly gamma: number;
  readonly thetaPerDay: number;
  readonly vegaPerPercent: number;
}
export type GreeksOutcome = Readonly<{ available: true; value: QualifiedGreeks } |
  { available: false; reason: "QUALIFIED_INSTRUMENT_REQUIRED" | "INVALID_INPUT" | "EXPIRED_OPTION" | "IV_UNAVAILABLE" }>;
export interface QualifiedGreeksInput {
  readonly instrument: InstrumentDefinition;
  readonly spotMinor: number;
  readonly optionPriceMinor: number;
  readonly valuationAt: string;
  readonly optionPriceTimestamp: string | null;
  readonly expiryAt: string;
  readonly expiryAssumptionVersion: string;
  readonly riskFreeRate: number;
  readonly riskFreeRateVersion: string;
  readonly dataMode: "KITE_REAL" | "MOCK";
  readonly source: "KITE" | "MOCK";
  readonly masterFingerprint: string;
}
const unavailable = (reason: Exclude<GreeksOutcome, { available: true }>["reason"]): GreeksOutcome =>
  freeze({ available: false, reason });
const positiveMinor = (n: number) => Number.isSafeInteger(n) && n > 0;
const version = (s: string) => typeof s === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(s);
const day = 86_400_000;
function bsmPrice(spot: number, strike: number, years: number, rate: number, iv: number, call: boolean): number {
  const d1 = computeD1(spot, strike, years, rate, iv), d2 = computeD2(d1, iv, years);
  const discounted = strike * Math.exp(-rate * years);
  return call ? spot * normalCDF(d1) - discounted * normalCDF(d2)
    : discounted * normalCDF(-d2) - spot * normalCDF(-d1);
}

/** Pure valuation: exact money stays in paise; Black-Scholes outputs are analytical floats. */
export function computeQualifiedGreeks(input: QualifiedGreeksInput): GreeksOutcome {
  try { assertQualifiedInstrument(input.instrument); }
  catch { return unavailable("QUALIFIED_INSTRUMENT_REQUIRED"); }
  const i = input.instrument;
  if (!positiveMinor(input.spotMinor) || !positiveMinor(i.strikeMinor) || !positiveMinor(input.optionPriceMinor)
    || (i.instrumentType !== "CE" && i.instrumentType !== "PE")
    || !Number.isFinite(input.riskFreeRate) || Math.abs(input.riskFreeRate) >= 1
    || !version(input.riskFreeRateVersion) || input.expiryAssumptionVersion !== "NSE_CLOSE_1530_V1"
    || !((input.dataMode === "KITE_REAL" && input.source === "KITE") || (input.dataMode === "MOCK" && input.source === "MOCK"))
    || input.masterFingerprint !== i.provenance.sourceFingerprint) return unavailable("INVALID_INPUT");
  let valuationAt: string, expiryAt: string, priceAt: string | null;
  try {
    valuationAt = marketTimestamp(input.valuationAt);
    expiryAt = marketTimestamp(input.expiryAt);
    priceAt = input.optionPriceTimestamp === null ? null : marketTimestamp(input.optionPriceTimestamp);
  } catch { return unavailable("INVALID_INPUT"); }
  const valuation = Date.parse(valuationAt), expiry = Date.parse(expiryAt);
  const expiryLocal = new Date(expiry + 19_800_000).toISOString();
  if (expiryLocal.slice(0, 10) !== i.expiry || expiryLocal.slice(11, 19) !== "15:30:00"
    || (priceAt !== null && Date.parse(priceAt) > valuation)) return unavailable("INVALID_INPUT");
  // One-hour minimum is explicit: do not replace zero/unstable TTE with a fabricated clamp.
  const years = (expiry - valuation) / (365 * day);
  if (years <= 0) return unavailable("EXPIRED_OPTION");
  if (years < 1 / (365 * 24)) return unavailable("IV_UNAVAILABLE");
  const spot = input.spotMinor / 100, strike = i.strikeMinor / 100, optionPrice = input.optionPriceMinor / 100;
  const discounted = strike * Math.exp(-input.riskFreeRate * years), call = i.instrumentType === "CE";
  const lower = call ? Math.max(0, spot - discounted) : Math.max(0, discounted - spot);
  const upper = call ? spot : discounted;
  if (optionPrice <= lower + 0.005 || optionPrice >= upper - 0.005) return unavailable("IV_UNAVAILABLE");
  let low = 0.0001, high = 5;
  if (bsmPrice(spot, strike, years, input.riskFreeRate, low, call) >= optionPrice
    || bsmPrice(spot, strike, years, input.riskFreeRate, high, call) <= optionPrice) return unavailable("IV_UNAVAILABLE");
  for (let n = 0; n < 90; n++) {
    const mid = (low + high) / 2;
    if (bsmPrice(spot, strike, years, input.riskFreeRate, mid, call) < optionPrice) low = mid;
    else high = mid;
  }
  const iv = (low + high) / 2, repriced = bsmPrice(spot, strike, years, input.riskFreeRate, iv, call);
  if (!Number.isFinite(iv) || !Number.isFinite(repriced) || Math.abs(repriced - optionPrice) > 0.005)
    return unavailable("IV_UNAVAILABLE");
  const d1 = computeD1(spot, strike, years, input.riskFreeRate, iv), d2 = computeD2(d1, iv, years);
  const delta = computeDelta(d1, call ? "CALL" : "PUT"), gamma = computeGamma(d1, spot, iv, years);
  const thetaPerDay = computeTheta(spot, strike, years, input.riskFreeRate, iv, d1, d2, call ? "CALL" : "PUT");
  const vegaPerPercent = computeVega(spot, d1, years);
  if (![delta, gamma, thetaPerDay, vegaPerPercent].every(Number.isFinite)
    || gamma < 0 || vegaPerPercent < 0 || (call ? delta < 0 || delta > 1 : delta < -1 || delta > 0))
    return unavailable("IV_UNAVAILABLE");
  return freeze({ available: true, value: { version: "QUALIFIED_BSM_IV_V1", instrument: i, canonicalId: i.canonicalId,
    dataMode: input.dataMode, source: input.source, masterFingerprint: input.masterFingerprint,
    valuationAt, optionPriceTimestamp: priceAt, expiryAt, expiryAssumptionVersion: input.expiryAssumptionVersion,
    riskFreeRate: input.riskFreeRate, riskFreeRateVersion: input.riskFreeRateVersion,
    spotMinor: input.spotMinor, optionPriceMinor: input.optionPriceMinor, impliedVolatility: iv,
    delta, gamma, thetaPerDay, vegaPerPercent } });
}
