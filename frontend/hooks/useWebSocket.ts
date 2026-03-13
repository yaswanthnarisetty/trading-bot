import { useCallback, useEffect, useRef } from "react";
import { wsMessageSchema, type WSMessage } from "@trading-bot/shared";
import { useAppContext } from "../context/AppContext";
import { getCookie } from "cookies-next";

const HEARTBEAT_TIMEOUT_MS = 40_000;

/**
 * Derives the WebSocket base URL from environment configuration.
 * Prefers NEXT_PUBLIC_WS_URL, falling back to NEXT_PUBLIC_API_URL with ws:// protocol.
 *
 * @returns A string base URL for WebSocket connections.
 */
function getWebSocketBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_WS_URL) {
    return process.env.NEXT_PUBLIC_WS_URL;
  }
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  return apiUrl.replace(/^http/, "ws");
}

/**
 * React hook managing the WebSocket lifecycle with auto-reconnect behavior.
 * All incoming messages are validated against the WSMessage Zod schema before dispatch.
 *
 * @returns An object exposing connect and disconnect functions for a session.
 */
export function useWebSocket(): {
  connect: (sessionId: string) => void;
  disconnect: () => void;
} {
  const { dispatch } = useAppContext();

  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const retryCountRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const manuallyDisconnectedRef = useRef(false);
  const lastHeartbeatCheckRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  );

  const scheduleReconnect = useCallback(() => {
    if (manuallyDisconnectedRef.current) {
      return;
    }

    retryCountRef.current += 1;
    const attempt = retryCountRef.current;

    if (attempt > 10) {
      dispatch({
        type: "WS_STATUS_CHANGED",
        payload: { status: "DISCONNECTED", retryCount: attempt },
      });
      return;
    }

    const delay =
      attempt <= 4
        ? 1000 * 2 ** (attempt - 1)
        : 30_000;

    dispatch({
      type: "WS_STATUS_CHANGED",
      payload: { status: "RECONNECTING", retryCount: attempt },
    });

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    reconnectTimeoutRef.current = setTimeout(() => {
      if (sessionIdRef.current) {
        openConnection(sessionIdRef.current);
      }
    }, delay);
  }, [dispatch]);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const raw = JSON.parse(event.data as string);
        console.log("WS RAW MESSAGE:", raw);
        const parsed = wsMessageSchema.safeParse(raw);
        if (!parsed.success) {
          // Invalid WS message is logged and discarded, never crashes the app.
          // eslint-disable-next-line no-console
          console.error("Invalid WSMessage received", parsed.error);
          return;
        }

        const message: WSMessage = parsed.data;

        switch (message.type) {
          case "SIGNAL": {
            dispatch({
              type: "SIGNAL_RECEIVED",
              payload: message.payload,
            });
            break;
          }
          case "POSITION_OPENED": {
            dispatch({
              type: "POSITION_OPENED",
              payload: message.payload,
            });
            break;
          }
          case "POSITION_CLOSED": {
            dispatch({
              type: "POSITION_CLOSED",
              payload: message.payload,
            });
            break;
          }
          case "POSITION_UPDATE": {
            dispatch({
              type: "POSITION_UPDATED",
              payload: message.payload,
            });
            break;
          }
          case "SESSION_STARTED": {
            dispatch({
              type: "SESSION_STARTED",
              payload: {
                sessionId: message.payload.sessionId,
                asset: message.payload.asset,
                paperCapital: message.payload.paperCapital,
                dataMode: "MOCK",
                startTime: null,
              },
            });
            break;
          }
          case "SESSION_STOPPED": {
            dispatch({ type: "SESSION_STOPPED" });
            break;
          }
          case "HEARTBEAT": {
            dispatch({
              type: "HEARTBEAT_RECEIVED",
              payload: { timestamp: message.timestamp },
            });
            break;
          }
          case "TICK_SKIPPED":
          case "TICK_ERROR":
            // For now these are only logged on the server; frontend can layer UX later.
            break;
          default:
            break;
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("Failed to handle WebSocket message", error);
      }
    },
    [dispatch]
  );

  const openConnection = useCallback(
    (sessionId: string) => {
      const baseUrl = getWebSocketBaseUrl();
      const token = getCookie("token");
      const url = `${baseUrl}?sessionId=${encodeURIComponent(sessionId)}&token=${token}`;

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        return;
      }

      dispatch({
        type: "WS_STATUS_CHANGED",
        payload: { status: "CONNECTING", retryCount: retryCountRef.current },
      });

      try {
        const ws = new WebSocket(url);
        wsRef.current = ws;
        sessionIdRef.current = sessionId;

        ws.onopen = () => {
          retryCountRef.current = 0;
          dispatch({
            type: "WS_STATUS_CHANGED",
            payload: { status: "CONNECTED", retryCount: 0 },
          });
        };

        ws.onmessage = handleMessage;

        ws.onerror = () => {
          scheduleReconnect();
        };

        ws.onclose = () => {
          if (!manuallyDisconnectedRef.current) {
            scheduleReconnect();
          } else {
            dispatch({
              type: "WS_STATUS_CHANGED",
              payload: { status: "DISCONNECTED", retryCount: 0 },
            });
          }
        };
      } catch {
        scheduleReconnect();
      }
    },
    [dispatch, handleMessage, scheduleReconnect]
  );

  const connect = useCallback(
    (sessionId: string) => {
      manuallyDisconnectedRef.current = false;
      openConnection(sessionId);
    },
    [openConnection]
  );

  const disconnect = useCallback(() => {
    manuallyDisconnectedRef.current = true;
    retryCountRef.current = 0;

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    if (lastHeartbeatCheckRef.current) {
      clearInterval(lastHeartbeatCheckRef.current);
      lastHeartbeatCheckRef.current = null;
    }

    sessionIdRef.current = null;
    dispatch({
      type: "WS_STATUS_CHANGED",
      payload: { status: "DISCONNECTED", retryCount: 0 },
    });
  }, [dispatch]);

  useEffect(() => {
    if (lastHeartbeatCheckRef.current) {
      clearInterval(lastHeartbeatCheckRef.current);
    }
    lastHeartbeatCheckRef.current = setInterval(() => {
      const now = Date.now();
      // If no heartbeat for 40s while connected, force reconnect.
      // Heartbeat timestamp is stored in AppState via HEARTBEAT_RECEIVED.
      // We read it via a dispatch-less closure by scheduling reconnection only.
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        // Ping is handled server-side; client only checks for missing heartbeats.
      }
      // The actual lastHeartbeat value is tracked by the store; for simplicity
      // we rely on the server-side reconnect behavior and manual reconnect action.
      // A more advanced implementation can pull state.ws.lastHeartbeat via a ref.
      if (
        sessionIdRef.current &&
        now - (window as any).__lastHeartbeatTs > HEARTBEAT_TIMEOUT_MS
      ) {
        if (wsRef.current) {
          wsRef.current.close();
        }
      }
    }, 10_000);

    return () => {
      if (lastHeartbeatCheckRef.current) {
        clearInterval(lastHeartbeatCheckRef.current);
        lastHeartbeatCheckRef.current = null;
      }
    };
  }, []);

  return { connect, disconnect };
}
