import type {
  ExpiryContext,
  IndicatorSnapshot,
  GreeksSnapshot,
  MonitoringSession,
  OptionsPosition,
  PrimarySignal,
  VerifierResult,
} from "@trading-bot/shared";
import { getCookie } from "cookies-next";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export interface Asset {
  key: string;
  lotSize: number;
  basePrice: number;
  expiryDay: number;
}

export interface SessionStartResponse {
  sessionId: string;
  asset: string;
  paperCapital: number;
  dataMode: "LIVE" | "MOCK";
}

export type SessionSummary = MonitoringSession;

export interface SignalLog {
  sessionId: string;
  asset: string;
  ltp?: number;
  signal: PrimarySignal;
  verifierResult: VerifierResult | null;
  riskAction: "SUGGEST" | "BLOCK";
  blockReason: string | null;
  indicators: IndicatorSnapshot;
  greeksSnapshot: GreeksSnapshot | null;
  expiryContext: ExpiryContext;
  dataMode: "LIVE" | "MOCK";
  timestamp: string;
}

export interface PaginatedSignals {
  signals: SignalLog[];
  total: number;
}

export interface PaginatedPositions {
  positions: OptionsPosition[];
  total: number;
}

export interface StrategyStats {
  trades: number;
  wins: number;
  pnl: number;
  winRate: number;
}

export interface DayStats {
  trades: number;
  winRate: number;
  avgPnL: number;
}

export type VsBacktestVerdict =
  | "OUTPERFORMING"
  | "IN_LINE"
  | "UNDERPERFORMING"
  | "INSUFFICIENT_DATA";

export interface PerformanceData {
  totalSignals: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnL: number;
  avgPnL: number;
  maxDrawdown: number;
  avgHoldingMinutes: number;
  profitFactor: number;
  expectancy: number;
  maxConsecutiveLosses: number;
  byStrategy: {
    BULL_PUT_SPREAD: StrategyStats;
    BEAR_CALL_SPREAD: StrategyStats;
  };
  byDayOfWeek: Record<string, DayStats>;
  vsBacktest: {
    backtestWinRate: number;
    liveWinRate: number;
    backtestExpectancy: number;
    liveExpectancy: number;
    verdict: VsBacktestVerdict;
  };
  exitReasons: {
    TARGET_HIT: number;
    SL_HIT: number;
    TIME_EXIT: number;
    EOD_FORCED_CLOSE: number;
    SESSION_STOP: number;
    NEAR_EXPIRY: number;
    EOD_CLOSE: number;
  };
  equityCurve: { timestamp: string; pnl: number }[];
  rollingWinRate: { index: number; winRate: number }[];
  strategyDistribution: {
    BULL_PUT_SPREAD: number;
    BEAR_CALL_SPREAD: number;
    HOLD: number;
  };
  confidenceAccuracy: {
    confidence: number;
    pnl: number;
    strategy: string;
  }[];
  premiumSourceCounts: Record<string, number>;
  bestTrade: OptionsPosition | null;
  worstTrade: OptionsPosition | null;
  recentTrades: OptionsPosition[];
}

export type BacktestInterval =
  | "minute"
  | "3minute"
  | "5minute"
  | "10minute"
  | "15minute"
  | "30minute"
  | "60minute";

export interface BacktestTrade {
  tradeId: string;
  strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
  entryTimestamp: string;
  exitTimestamp: string;
  entrySpot: number;
  exitSpot: number;
  barsHeld: number;
  lots: number;
   optionType: "CALL" | "PUT";
   sellStrike: number;
   buyStrike: number;
   width: number;
   credit: number;
   breakeven: number;
  maxProfit: number;
  maxLoss: number;
  pnl: number;
  exitReason: "TARGET_HIT" | "STOP_HIT" | "DIRECTIONAL_STOP" | "TIME_EXIT" | "EOD_CLOSE" | "END_OF_DATA";
}

export interface BacktestBlockReasons {
  duplicate_strategy: number;
  same_direction_open: number;
  max_positions: number;
  daily_limit: number;
  low_confidence: number;
  time_restriction: number;
}

export interface BacktestResult {
  provider: "FIXTURE" | "KITE_ARCHIVE";
  dataMode: "HISTORICAL_REPLAY";
  status: "COMPLETE" | "INCOMPLETE";
  missingExitObservations: number;
  missingEntryObservations: number;
  completeness: { version: "REPLAY_COMPLETENESS_V1"; missingCandleCoverage: number;
    truncatedCoverage: boolean; missingRequiredOptionObservations: number;
    unavailableRequiredAnalytics: number; incompleteContractUniverse: number };
  asset: string;
  interval: BacktestInterval;
  from: string;
  to: string;
  dataPoints: number;
  initialCapital: number;
  finalCapital: number;
  netPnL: number;
  totalSignals: number;
  totalBlocked: number;
  totalTraded: number;
  blockReasons: BacktestBlockReasons;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnLPerTrade: number;
  maxDrawdown: number;
  equityCurve: Array<{ timestamp: string; equity: number }>;
  trades: BacktestTrade[];
}

export interface BacktestRunInput {
  asset: string;
  from: string;
  to: string;
  interval?: BacktestInterval;
  initialCapital?: number;
  riskPerTradePct?: number;
  targetProfitPct?: number;
  stopLossPct?: number;
  maxHoldingBars?: number;
}

export class ApiError extends Error {
  status: number;
  body: unknown;

  /**
   * Creates a typed API error carrying HTTP status code and parsed body.
   * This enables callers to distinguish transport errors from domain failures.
   *
   * @param message - Human-readable error description.
   * @param status - HTTP status code returned by the server.
   * @param body - Parsed JSON payload or raw response used for debugging.
   */
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Low-level JSON fetch wrapper that throws ApiError on non-2xx responses.
 * All higher-level API helpers should delegate to this function.
 *
 * @param path - Relative API path under the base URL.
 * @param init - Fetch initialization options including method and body.
 * @returns Parsed JSON response body as type T.
 */
async function request<T>(
  path: string,
  init?: RequestInit
): Promise<T> {

  const token = getCookie("token");

  const url = `${API_BASE_URL}${path}`;

  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: token ? `Bearer ${token}` : "",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  let body: unknown = null;

  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.status === 401) {
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
  }

  if (!response.ok) {
    throw new ApiError(
      (body as any)?.error ?? response.statusText,
      response.status,
      body
    );
  }

  return body as T;
}

/**
 * Fetches the list of allowed trading assets from the backend.
 * Used by the asset selector to constrain user choices to supported indices.
 *
 * @returns Promise resolving to an array of asset configurations.
 */
export function getAssets(): Promise<Asset[]> {
  return request<Asset[]>("/api/assets");
}

/**
 * Starts a new monitoring session for the specified asset.
 * Backend enforces single RUNNING session at a time.
 *
 * @param asset - Asset key such as "NIFTY" or "BANKNIFTY".
 * @returns Promise resolving to session start metadata.
 */
export function startSession(
  asset: string
): Promise<SessionStartResponse> {
  return request<SessionStartResponse>("/api/session/start", {
    method: "POST",
    body: JSON.stringify({ asset }),
  });
}

/**
 * Stops an existing monitoring session and returns its final summary.
 * The backend will close all open positions with EOD semantics.
 *
 * @param sessionId - Identifier of the running session.
 * @returns Promise resolving to the updated MonitoringSession document.
 */
export function stopSession(
  sessionId: string
): Promise<SessionSummary> {
  return request<SessionSummary>("/api/session/stop", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

/**
 * Retrieves the currently active monitoring session, if any.
 * Used by the frontend to rehydrate state on page load.
 *
 * @returns Promise resolving to MonitoringSession or null.
 */
export function getActiveSession(): Promise<MonitoringSession | null> {
  return request<MonitoringSession | null>("/api/session/active");
}

/**
 * Returns paginated signal history for a session.
 * Signals are ordered by timestamp descending on the server.
 *
 * @param sessionId - Identifier of the monitoring session.
 * @param limit - Maximum number of signals to fetch (max 50 enforced server-side).
 * @param offset - Number of records to skip for pagination.
 * @returns Promise resolving to a PaginatedSignals payload.
 */
export function getSignalHistory(
  sessionId: string,
  limit: number,
  offset: number
): Promise<PaginatedSignals> {
  const search = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  }).toString();
  return request<PaginatedSignals>(
    `/api/signals/${encodeURIComponent(sessionId)}?${search}`
  );
}

/**
 * Fetches positions for a session filtered by status.
 * Supports simple pagination for dashboard and tables.
 *
 * @param sessionId - Identifier for the monitoring session.
 * @param status - OPEN, CLOSED, or ALL as understood by the backend.
 * @param limit - Maximum number of positions to retrieve.
 * @param offset - Number of rows to skip.
 * @returns Promise resolving to a PaginatedPositions payload.
 */
export function getPositions(
  sessionId: string,
  status: "OPEN" | "CLOSED" | "ALL",
  limit: number,
  offset: number
): Promise<PaginatedPositions> {
  const search = new URLSearchParams({
    status,
    limit: String(limit),
    offset: String(offset),
  }).toString();
  return request<PaginatedPositions>(
    `/api/positions/${encodeURIComponent(sessionId)}?${search}`
  );
}

export interface PositionHistoryParams {
  startDate?: string;
  endDate?: string;
  strategy?: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD" | "HOLD";
  limit?: number;
  offset?: number;
}

/**
 * Returns cross-session position history with optional filters.
 * Useful for analytics views that span multiple sessions and days.
 *
 * @param params - Filter and pagination options for position history.
 * @returns Promise resolving to a PaginatedPositions payload.
 */
export function getPositionHistory(
  params: PositionHistoryParams
): Promise<PaginatedPositions> {
  const search = new URLSearchParams();
  if (params.startDate) search.set("startDate", params.startDate);
  if (params.endDate) search.set("endDate", params.endDate);
  if (params.strategy) search.set("strategy", params.strategy);
  if (params.limit != null) search.set("limit", String(params.limit));
  if (params.offset != null) search.set("offset", String(params.offset));

  const query = search.toString();
  const path = query ? `/api/positions/history?${query}` : "/api/positions/history";
  return request<PaginatedPositions>(path);
}

/**
 * Fetches aggregated performance metrics for a session.
 * This powers equity curves, strategy breakdowns, and confidence analytics.
 *
 * @param sessionId - Identifier of the monitoring session.
 * @returns Promise resolving to a PerformanceData payload.
 */
export function getPerformance(
  sessionId: string,
  from?: string,
  to?: string
): Promise<PerformanceData> {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const query = params.toString();
  return request<PerformanceData>(
    `/api/performance/${encodeURIComponent(sessionId)}${query ? `?${query}` : ""}`
  );
}

/**
 * Fetches performance data for all sessions (aggregate list).
 * Useful for admin lists or cross-session analytics.
 */
export function getAllPerformance(): Promise<PerformanceData> {
  return request<PerformanceData>("/api/performance/all");
}

/**
 * Closes a position manually using the backend paper trading engine.
 * The server records realized PnL and broadcasts a POSITION_CLOSED WS event.
 *
 * @param positionId - Identifier of the paper position to close.
 * @returns Promise resolving to the updated OptionsPosition.
 */
export function closePosition(
  positionId: string
): Promise<OptionsPosition> {
  return request<OptionsPosition>(
    `/api/positions/${encodeURIComponent(positionId)}/close`,
    {
      method: "PATCH",
      body: JSON.stringify({ reason: "MANUAL" }),
    }
  );
}

/**
 * Runs historical backtest simulation for a selected asset and date range.
 * Useful for analysis when live market is closed.
 *
 * @param input - Replay configuration; historical archive selection is server-owned.
 * @returns Promise resolving to full backtest result set.
 */
export function runBacktest(
  input: BacktestRunInput
): Promise<BacktestResult> {
  return request<BacktestResult>("/api/backtest/run", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface KiteConfig {
  tradingPhase: "PAPER";
  execution: "PaperBroker";
  paperCapital: number;
  minConfidence: number;
  maxPositions: number;
}

export interface KiteStatus {
  tokenValid: boolean;
  dataMode: "KITE_REAL" | "MOCK";
  connectionStatus: "CONNECTED" | "DISCONNECTED" | "SESSION_REQUIRED";
  apiKey: string;
  tokenExpiry: string;
  loginAvailable: boolean;
  message: string;
  config: KiteConfig;
}

export interface KiteRefreshResult {
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * Returns current Kite token validity, data mode, masked API key, and config.
 *
 * @returns Promise resolving to KiteStatus payload.
 */
export function getKiteStatus(): Promise<KiteStatus> {
  return request<KiteStatus>("/api/kite/status");
}

/**
 * Exchanges a one-time request_token for a fresh Kite access token.
 * The server verifies the profile and retains credentials only in memory.
 *
 * @param requestToken - Token from the Kite login redirect URL query param.
 * @returns Promise resolving to success/failure result.
 */
export function refreshKiteToken(requestToken: string): Promise<KiteRefreshResult> {
  return request<KiteRefreshResult>("/api/kite/refresh", {
    method: "POST",
    body: JSON.stringify({ requestToken }),
  });
}

export function beginKiteLogin(): Promise<{ loginUrl: string }> {
  return request("/api/kite/login", { method: "POST" });
}
export function setKiteDataMode(dataMode: "MOCK" | "KITE_REAL"): Promise<{ dataMode: "MOCK" | "KITE_REAL" }> {
  return request("/api/kite/data-mode", { method: "POST", body: JSON.stringify({ dataMode }) });
}
