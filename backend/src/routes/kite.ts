import { Router, type Request, type Response } from "express";
import { kiteSession } from "../services/KiteService";
import { kiteMarketData } from "../services/KiteMarketDataRuntime";
import { kiteIndexData } from "../services/KiteIndexDataRuntime";
import type { KiteSessionService } from "../services/KiteSessionService";
import type { KiteMarketDataService, HistoricalInterval } from "../services/KiteMarketDataService";
import type { KiteIndexDataService } from "../services/KiteIndexDataService";
import { authMiddleware } from "./auth.middleware";
import { fail, safeMarketError } from "../domain/kiteMarketData";
import type { AssetKey } from "../config/assets";

const SETTINGS = "http://localhost:3000/settings";
/** Public callback uses one-use state minted by authenticated POST /login. */
export function createKiteCallback(session: KiteSessionService) {
  return async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
    try { await session.callback(req.query); res.redirect(303, `${SETTINGS}?kite=connected`); }
    catch (error) { res.redirect(303, `${SETTINGS}?kite=error&code=${safeMarketError(error).code}`); }
  };
}
export function createKiteRouter(session: KiteSessionService, market: KiteMarketDataService, indices?: KiteIndexDataService) {
  const router = Router();
  router.use(authMiddleware, (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const action = (fn: (req: Request, res: Response) => Promise<void> | void) => async (req: Request, res: Response) => {
    try { await fn(req, res); } catch (error) { res.status(400).json({ success: false, error: safeMarketError(error).code }); }
  };
  router.get("/status", action(async (_req, res) => {
    if (session.status().tokenValid) await session.validate();
    const status = session.status(), key = process.env.KITE_API_KEY ?? "";
    res.json({ ...status, apiKey: key ? `***${key.slice(-4)}` : "not set", loginAvailable: !!key,
      message: status.connectionStatus, config: { tradingPhase: "PAPER", execution: "PaperBroker",
        paperCapital: Number(process.env.PAPER_CAPITAL ?? 200000), minConfidence: Number(process.env.MIN_CONFIDENCE ?? 0.65), maxPositions: Number(process.env.MAX_POSITIONS ?? 3) } });
  }));
  router.post("/login", action((_req, res) => { res.json({ loginUrl: session.beginLogin() }); }));
  router.post("/refresh", action(async (req, res) => { await session.exchange(req.body?.requestToken); res.json({ success: true, message: "Kite session connected" }); }));
  router.post("/data-mode", action((req, res) => { session.setMode(req.body?.dataMode); res.json({ dataMode: session.getMode() }); }));
  router.post("/master/refresh", action(async (_req, res) => {
    const master = await market.refreshMaster(); res.json({ provenance: master.provenance, instrumentCount: master.instruments.length });
  }));
  router.get("/instrument-search", action((req, res) => {
    const master = market.activeMaster();
    res.json({ provenance: master.provenance, instruments: master.instruments.filter(i =>
      (!req.query.symbol || i.underlying === req.query.symbol) && (!req.query.expiry || i.expiry === req.query.expiry)
      && (!req.query.strike || i.strike === req.query.strike)).slice(0, 200) });
  }));
  const instrument = (req: Request) => {
    if (typeof req.query.canonicalId !== "string") return fail("QUALIFIED_INSTRUMENT_REQUIRED");
    try { return market.activeMaster().getInstrumentByCanonicalId(req.query.canonicalId); }
    catch (error) { if (error instanceof Error && error.message === "INSTRUMENT_NOT_FOUND") return fail("HISTORICAL_INSTRUMENT_UNAVAILABLE"); throw error; }
  };
  router.get("/market-data/quote", action(async (req, res) => {
    const i = instrument(req), age = typeof req.query.maxAgeMs === "string" ? Number(req.query.maxAgeMs) : NaN;
    const kind = req.query.kind ?? "QUOTE";
    if (!["LTP", "OHLC", "QUOTE"].includes(String(kind))) return fail("INVALID_REQUEST");
    res.json(await (kind === "LTP" ? market.getLtp(i, age) : kind === "OHLC" ? market.getOhlc(i, age) : market.getQuote(i, age)));
  }));
  router.get("/market-data/history", action(async (req, res) => {
    res.json(await market.getHistoricalCandles({ instrument: instrument(req), from: req.query.from as string,
      to: req.query.to as string, interval: req.query.interval as HistoricalInterval }));
  }));
  router.post("/index-master/refresh", action(async (_req, res) => {
    if (!indices) return fail("INSTRUMENT_MASTER_STALE");
    const master = await indices.refreshMaster();
    res.json({ provenance: master.provenance, indices: master.indices });
  }));
  const index = (req: Request) => {
    if (!indices || typeof req.query.underlying !== "string") return fail("QUALIFIED_INSTRUMENT_REQUIRED");
    return indices.activeMaster().resolve(req.query.underlying as AssetKey);
  };
  router.get("/index-data/quote", action(async (req, res) => {
    if (!indices) return fail("INSTRUMENT_MASTER_STALE");
    const maxAgeMs = typeof req.query.maxAgeMs === "string" ? Number(req.query.maxAgeMs) : NaN;
    res.json(await indices.getQuote(index(req), maxAgeMs));
  }));
  router.get("/index-data/history", action(async (req, res) => {
    if (!indices) return fail("INSTRUMENT_MASTER_STALE");
    res.json(await indices.getHistoricalCandles({ index: index(req), from: req.query.from as string,
      to: req.query.to as string, interval: req.query.interval as HistoricalInterval }));
  }));
  return router;
}
export const kiteCallback = createKiteCallback(kiteSession);
export default createKiteRouter(kiteSession, kiteMarketData, kiteIndexData);
