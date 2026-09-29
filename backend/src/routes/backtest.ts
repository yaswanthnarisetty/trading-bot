import { Router, type Request, type Response, type NextFunction } from "express";
import { BacktestError, normalizeBacktestParams, runHistoricalBacktest } from "../services/BacktestService";
import type { HistoricalReplayProvider } from "../domain/historicalReplay";
import { authMiddleware } from "./auth.middleware";

/** Archive selection is a trusted bootstrap dependency, never a request URL/path/token. */
export function createBacktestHandler(provider?: HistoricalReplayProvider) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const params = normalizeBacktestParams(req.body);
      res.json(await runHistoricalBacktest(params, { provider }));
    } catch (error) {
      if (error instanceof BacktestError) {
        res.status(error.status).json({ error: error.code, code: error.code }); return;
      }
      // No provider exception body or credentials are exposed to the caller.
      res.status(422).json({ error: "INVALID_HISTORICAL_EVIDENCE", code: "INVALID_HISTORICAL_EVIDENCE" });
    }
  };
}
export function createBacktestRouter(provider?: HistoricalReplayProvider) {
  const router = Router();
  router.post("/run", authMiddleware, createBacktestHandler(provider));
  return router;
}
export default createBacktestRouter();
