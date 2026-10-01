import { readFile } from "node:fs/promises";
import { NIFTY_OPERATIONAL_DEFAULTS as defaults, assertNiftyDefaultsCoverage } from "../config/niftyOperationalDefaults";
import { completeOperationalPaperEntryConfig, type PaperMonitoringConfig } from "../domain/paperMonitoring";
import { captureExitConfig } from "../domain/paperExits";
import { monthlyExpiryConfiguration } from "./KiteMarketDataRuntime";
import { nseLocalDate } from "../domain/nseTradingCalendar";

export async function operationalEntryConfiguration(config: PaperMonitoringConfig, now = new Date(), env = process.env) {
  let metadata: unknown = {};
  if (env.NSE_PAPER_ENTRY_METADATA_FILE) {
    try { metadata = JSON.parse(await readFile(env.NSE_PAPER_ENTRY_METADATA_FILE, "utf8")); }
    catch { throw new Error("ENTRY_METADATA_INVALID"); }
  } else if (config.accountId === "PAPER:NSE" && config.asset === "NIFTY" && config.dataMode === "KITE_REAL"
    && config.strategyConfig.strategyFamily === "LONG_OPTION" && config.riskFreeRate === null && config.riskFreeRateVersion === null) {
    assertNiftyDefaultsCoverage(now, "GREEKS_CONFIG_REQUIRED");
    metadata = { riskFreeRate: defaults.greeks.riskFreeRate, riskFreeRateVersion: defaults.greeks.riskFreeRateVersion };
  }
  // A partial explicit pair must not combine with an unrelated default assumption.
  if ((config.riskFreeRate === null) !== (config.riskFreeRateVersion === null)) throw new Error("GREEKS_CONFIG_REQUIRED");
  try { return completeOperationalPaperEntryConfig(config, metadata, now); }
  catch (e) {
    if (e instanceof Error && ["CALENDAR_NOT_READY", "GREEKS_CONFIG_REQUIRED", "CALENDAR_AUTHORITY_CONFLICT"].includes(e.message)) throw e;
    throw new Error("ENTRY_METADATA_INVALID");
  }
}

export async function operationalExitConfigurations(env = process.env) {
  const file = env.NSE_PAPER_EXIT_CONFIG_FILE;
  if (!file) return [defaults.exitPolicy];
  try {
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(raw) || raw.length > 150) throw new Error();
    const configs = raw.map(captureExitConfig);
    if (new Set(configs.map(c => `${c.accountId}:${c.family}`)).size !== configs.length) throw new Error();
    return configs;
  } catch { throw new Error("EXIT_CONFIG_REQUIRED"); }
}

/** Read-only configuration visibility; this does not claim tradable readiness. */
export async function operationalDefaultsStatus(config: PaperMonitoringConfig, now = new Date(), env = process.env) {
  const describe = async <T>(read: () => Promise<T>) => {
    try { return { status: "VALID" as const, value: await read(), reason: null }; }
    catch (e) { return { status: "UNAVAILABLE" as const, value: null, reason: e instanceof Error ? e.message : "CONFIGURATION_REQUIRED" }; }
  };
  const greeks = await describe(async () => {
    const resolved = await operationalEntryConfiguration(config, now, env);
    return { riskFreeRate: resolved.riskFreeRate, version: resolved.riskFreeRateVersion,
      source: !env.NSE_PAPER_ENTRY_METADATA_FILE && config.riskFreeRate === null
        ? defaults.greeks.sourceReference : "EXPLICIT_SERVER_CONFIGURATION",
      expiryAssumptionVersion: defaults.greeks.expiryAssumptionVersion };
  });
  const monthlyExpiry = await describe(async () => {
    const metadata = await monthlyExpiryConfiguration(now, env);
    const upcoming = metadata.records.filter(r => r.underlying === config.asset && r.expiry >= nseLocalDate(now)).map(r => r.expiry);
    if (!upcoming.length) throw new Error("MONTHLY_METADATA_REQUIRED");
    return { version: metadata.version, source: metadata.source, upcoming: upcoming.sort(),
      coveredTo: metadata.scope?.coveredTo ?? null };
  });
  const exitPolicy = await describe(async () => {
    const choices = (await operationalExitConfigurations(env)).filter(c => c.accountId === config.accountId
      && c.family === config.strategyConfig.strategyFamily && (!c.underlying || c.underlying === config.asset));
    if (choices.length !== 1) throw new Error("EXIT_CONFIG_REQUIRED");
    return choices[0];
  });
  return { version: defaults.version, greeks, monthlyExpiry, exitPolicy };
}
