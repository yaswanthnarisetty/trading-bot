import React, {
  createContext,
  useContext,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import type {
  SignalPayload,
  OptionsPosition,
  IndicatorSnapshot,
  GreeksSnapshot,
  ExpiryContext,
  MonitoringSession,
} from "@trading-bot/shared";

type SessionStatus = "IDLE" | "RUNNING" | "STOPPED" | "CRASHED" | "UNAVAILABLE";

type DataMode = "LIVE" | "MOCK" | "KITE_REAL" | null;

type WebSocketStatus =
  | "CONNECTED"
  | "CONNECTING"
  | "RECONNECTING"
  | "DISCONNECTED";

export interface AppState {
  session: {
    id: string | null;
    accountId: string | null;
    configId: string | null;
    status: SessionStatus;
    asset: string | null;
    startTime: string | null;
    ticksSkipped: number;
    totalSignals: number;
    dataMode: DataMode;
    paperCapital: number;
  };
  currentSignal: SignalPayload | null;
  signalHistory: SignalPayload[];
  positions: OptionsPosition[];
  indicators: IndicatorSnapshot | null;
  greeksSnapshot: GreeksSnapshot | null;
  expiryContext: ExpiryContext | null;
  /** S/R context from the latest signal tick. null until first live tick with SR data. */
  srContext: unknown | null;
  /** Breakout detection result from the latest signal tick. null until first tick. */
  breakoutResult: unknown | null;
  paperPnL: number;
  openPositionsCount: number;
  positionRealtime: Record<
    string,
    {
      currentPnL: number;
      currentLTP: number;
      lastUpdatedAt: number | null;
    }
  >;
  ws: {
    status: WebSocketStatus;
    retryCount: number;
    lastHeartbeat: number | null;
  };
}

type SessionStartedPayload = {
  sessionId: string;
  asset: string;
  paperCapital: number;
  dataMode: "LIVE" | "MOCK" | "KITE_REAL";
  startTime: string | null;
};

type WSStatusChangedPayload = {
  status: WebSocketStatus;
  retryCount?: number;
};

type PositionUpdatePayload = {
  positionId: string;
  currentPnL: number;
  currentLTP: number;
};

export type AppAction =
  | { type: "SESSION_STARTED"; payload: SessionStartedPayload }
  | { type: "SESSION_SYNCED"; payload: MonitoringSession & { config?: { configId: string } } }
  | { type: "SESSION_STOPPED" }
  | { type: "SESSION_UNAVAILABLE" }
  | { type: "SIGNAL_RECEIVED"; payload: SignalPayload }
  | { type: "SIGNALS_SYNCED"; payload: SignalPayload[] }
  | { type: "POSITION_OPENED"; payload: OptionsPosition }
  | { type: "POSITIONS_SYNCED"; payload: OptionsPosition[] }
  | { type: "POSITION_CLOSED"; payload: OptionsPosition }
  | { type: "POSITION_UPDATED"; payload: PositionUpdatePayload }
  | { type: "WS_STATUS_CHANGED"; payload: WSStatusChangedPayload }
  | { type: "HEARTBEAT_RECEIVED"; payload: { timestamp: number } }
  | { type: "RESET" };

const initialState: AppState = {
  session: {
    id: null,
    accountId: null,
    configId: null,
    status: "IDLE",
    asset: null,
    startTime: null,
    ticksSkipped: 0,
    totalSignals: 0,
    dataMode: null,
    paperCapital: 0,
  },
  currentSignal: null,
  signalHistory: [],
  positions: [],
  indicators: null,
  greeksSnapshot: null,
  expiryContext: null,
  srContext: null,
  breakoutResult: null,
  paperPnL: 0,
  openPositionsCount: 0,
  positionRealtime: {},
  ws: {
    status: "DISCONNECTED",
    retryCount: 0,
    lastHeartbeat: null,
  },
};

/**
 * Pure reducer for global trading application state.
 * All state transitions are deterministic; side effects live in hooks/components.
 *
 * @param state - The previous immutable application state.
 * @param action - The dispatched action describing the state transition.
 * @returns The next application state after applying the action.
 */
export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SESSION_STARTED": {
      if (state.session.id && state.session.id !== action.payload.sessionId) return state;
      const { sessionId, asset, paperCapital, dataMode, startTime } =
        action.payload;
      return {
        ...state,
        session: {
          id: sessionId,
          accountId: state.session.accountId,
          configId: state.session.configId,
          status: "RUNNING",
          asset,
          startTime,
          ticksSkipped: 0,
          totalSignals: 0,
          dataMode,
          paperCapital,
        },
        paperPnL: 0,
        openPositionsCount: 0,
        positionRealtime: {},
        signalHistory: [],
        currentSignal: null,
      };
    }
    case "SESSION_SYNCED": {
      const session = action.payload;
      return {
        ...state,
        session: {
          id: session.sessionId,
          accountId: session.accountId ?? null,
          configId: session.config?.configId ?? null,
          status: session.status,
          asset: session.asset,
          startTime: session.startTime,
          ticksSkipped: session.ticksSkipped,
          totalSignals: session.totalSignals,
          dataMode: session.dataMode,
          paperCapital: session.paperCapital,
        },
        paperPnL: session.paperPnL,
      };
    }
    case "SESSION_UNAVAILABLE": {
      return { ...state, session: { ...state.session, status: "UNAVAILABLE" } };
    }
    case "SESSION_STOPPED": {
      return {
        ...state,
        session: {
          ...state.session,
          status: "STOPPED",
        },
      };
    }
    case "SIGNAL_RECEIVED": {
      const signal = action.payload;
      const updatedHistory = [signal, ...state.signalHistory].slice(0, 10);
      return {
        ...state,
        currentSignal: signal,
        signalHistory: updatedHistory,
        indicators: signal.indicators,
        greeksSnapshot: signal.greeksSnapshot,
        expiryContext: signal.expiryContext,
        srContext: (signal as unknown as { srContext?: unknown }).srContext ?? state.srContext,
        breakoutResult: (signal as unknown as { breakoutResult?: unknown }).breakoutResult ?? state.breakoutResult,
        paperPnL: signal.paperPnL,
        openPositionsCount: signal.openPositions,
        session: {
          ...state.session,
          dataMode: signal.dataMode,
          totalSignals: Math.max(state.session.totalSignals + 1, updatedHistory.length),
        },
      };
    }
    case "SIGNALS_SYNCED": {
      const signals = action.payload;
      const latest = signals[0] ?? null;
      return {
        ...state,
        currentSignal: latest,
        signalHistory: signals,
        indicators: latest?.indicators ?? state.indicators,
        greeksSnapshot: latest?.greeksSnapshot ?? state.greeksSnapshot,
        expiryContext: latest?.expiryContext ?? state.expiryContext,
      };
    }
    case "POSITIONS_SYNCED": {
      return {
        ...state,
        positions: action.payload,
        openPositionsCount: action.payload.filter((p) => p.status === "OPEN")
          .length,
      };
    }
    case "POSITION_OPENED": {
      const existing = state.positions.find(
        (p) => p.positionId === action.payload.positionId
      );
      const positions = existing
        ? state.positions
        : [action.payload, ...state.positions];
      return {
        ...state,
        positions,
        openPositionsCount: positions.filter(
          (p) => p.status === "OPEN"
        ).length,
      };
    }
    case "POSITION_CLOSED": {
      const updated = state.positions.map((p) =>
        p.positionId === action.payload.positionId ? action.payload : p
      );
      return {
        ...state,
        positions: updated,
        openPositionsCount: updated.filter(
          (p) => p.status === "OPEN"
        ).length,
        positionRealtime: {
          ...state.positionRealtime,
          [action.payload.positionId]:
            state.positionRealtime[action.payload.positionId] ?? {
              currentPnL: action.payload.realizedPnL ?? 0,
              currentLTP: action.payload.entrySpot,
              lastUpdatedAt: null,
            },
        },
      };
    }
    case "POSITION_UPDATED": {
      return {
        ...state,
        positionRealtime: {
          ...state.positionRealtime,
          [action.payload.positionId]: {
            currentPnL: action.payload.currentPnL,
            currentLTP: action.payload.currentLTP,
            lastUpdatedAt: Date.now(),
          },
        },
      };
    }
    case "WS_STATUS_CHANGED": {
      const { status, retryCount } = action.payload;
      return {
        ...state,
        ws: {
          ...state.ws,
          status,
          retryCount: retryCount ?? state.ws.retryCount,
        },
      };
    }
    case "HEARTBEAT_RECEIVED": {
      return {
        ...state,
        ws: {
          ...state.ws,
          lastHeartbeat: action.payload.timestamp,
        },
      };
    }
    case "RESET": {
      return initialState;
    }
    default:
      return state;
  }
}

interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<AppAction>;
}

const AppContext = createContext<AppContextValue | undefined>(undefined);

interface AppProviderProps {
  children: ReactNode;
}

/**
 * React context provider that exposes global trading state and dispatch.
 * Wrap the root layout with this provider to make AppState available throughout the app.
 *
 * @param props - React children to render within the provider boundary.
 * @returns A provider element wiring useReducer into React Context.
 */
export function AppProvider({ children }: AppProviderProps): JSX.Element {
  const [state, dispatch] = useReducer(appReducer, initialState);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}

/**
 * Hook to access the global AppContext.
 * This provides read/write access to AppState and dispatch within components and hooks.
 *
 * @returns The current AppContext value containing state and dispatch.
 * @throws If used outside of an AppProvider.
 */
export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useAppContext must be used within an AppProvider");
  }
  return ctx;
}
