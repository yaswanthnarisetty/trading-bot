import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import type { WSMessage } from "@trading-bot/shared";
import { WS_HEARTBEAT_INTERVAL_MS } from "../config/constants";
import { logger } from "../utils/logger";
import jwt from "jsonwebtoken";

interface ClientMeta {
  sessionId: string | null;
  lastPong: number;
}

const rooms = new Map<string, Set<WebSocket>>();
const clientMeta = new WeakMap<WebSocket, ClientMeta>();

let wss: WebSocketServer | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;

/**
 * Assigns a WebSocket connection to a logical session room.
 * This enables targeted broadcast of trading events per monitoring session.
 *
 * @param ws - The WebSocket connection to assign.
 * @param sessionId - Identifier of the room/session to join.
 */
function joinRoom(ws: WebSocket, sessionId: string): void {
  let set = rooms.get(sessionId);
  if (!set) {
    set = new Set<WebSocket>();
    rooms.set(sessionId, set);
  }
  set.add(ws);

  const meta = clientMeta.get(ws) ?? { sessionId: null, lastPong: Date.now() };
  meta.sessionId = sessionId;
  clientMeta.set(ws, meta);
}

/**
 * Removes a WebSocket connection from its session room, if any.
 * This is called on explicit close or inactivity timeouts.
 *
 * @param ws - The WebSocket connection being removed.
 */
function leaveRoom(ws: WebSocket): void {
  const meta = clientMeta.get(ws);
  if (!meta || !meta.sessionId) {
    return;
  }

  const set = rooms.get(meta.sessionId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) {
      rooms.delete(meta.sessionId);
    }
  }
}

/**
 * Initializes the WebSocket server and attaches it to the existing HTTP server.
 * This is called once on backend startup to enable real-time dashboard updates.
 *
 * @param server - The HTTP server instance to attach to.
 */
function init(server: http.Server): void {
  if (wss) {
    return;
  }

  wss = new WebSocketServer({ server });

  wss.on("connection", (ws, req) => {
    handleConnection(ws, req);
  });

  startHeartbeat();
  logger.info("WebSocket server initialized");
}

/**
 * Handles a new WebSocket client connection and registers message/close handlers.
 * Clients are expected to join a session via a JOIN message or query parameter.
 *
 * @param ws - The newly connected WebSocket instance.
 * @param req - The HTTP upgrade request associated with the connection.
 */
function handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
  const url = new URL(req.url ?? "", "http://localhost");
  const sessionIdFromQuery = url.searchParams.get("sessionId");
  const token = url.searchParams.get("token");
  if (!token) {
      ws.close(4001, "Unauthorized");
      return;
    }
    try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!);

    // attach user info to connection
    (ws as any).user = decoded;

  } catch {
    ws.close(4001, "Invalid token");
    return;
  }
  
  if (sessionIdFromQuery) {
    joinRoom(ws, sessionIdFromQuery);
  }

  clientMeta.set(ws, {
    sessionId: sessionIdFromQuery,
    lastPong: Date.now(),
  });

  ws.on("message", (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed && parsed.type === "JOIN" && parsed.sessionId) {
        joinRoom(ws, String(parsed.sessionId));
      } else if (parsed && parsed.type === "PONG") {
        const meta = clientMeta.get(ws);
        if (meta) {
          meta.lastPong = Date.now();
          clientMeta.set(ws, meta);
        }
      }
    } catch (error) {
      logger.warn("Failed to parse incoming WebSocket message", { error });
    }
  });

  ws.on("close", () => {
    leaveRoom(ws);
  });

  ws.on("error", (error) => {
    logger.warn("WebSocket client error", { error });
    leaveRoom(ws);
  });
}

/**
 * Emits a message to all WebSocket clients joined to the given session.
 * Messages must conform to the WSMessage union type from the shared package.
 *
 * @param sessionId - Identifier of the session room to broadcast to.
 * @param message - The strongly typed WSMessage payload to send.
 */
function emit(sessionId: string, message: WSMessage): void {
  const set = rooms.get(sessionId);
  if (!set) {
    return;
  }

  const payload = JSON.stringify(message);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(payload);
      } catch (error) {
        logger.warn("Failed to emit WebSocket message to client", {
          sessionId,
          error,
        });
      }
    }
  }
}

/**
 * Broadcasts a message to every connected WebSocket client.
 * This is primarily used for system-wide signals such as heartbeats.
 *
 * @param message - The WSMessage to broadcast to all clients.
 */
function emitAll(message: WSMessage): void {
  const payload = JSON.stringify(message);

  if (!wss) {
    return;
  }

  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(payload);
      } catch (error) {
        logger.warn("Failed to broadcast WebSocket message", { error });
      }
    }
  });
}

/**
 * Starts the heartbeat loop to keep WebSocket connections healthy.
 * Clients are considered stale and removed if they do not respond within 40 seconds.
 */
function startHeartbeat(): void {
  if (heartbeatInterval) {
    return;
  }

  heartbeatInterval = setInterval(() => {
    const now = Date.now();

    if (!wss) {
      return;
    }

    wss.clients.forEach((ws) => {
      const meta = clientMeta.get(ws);
      if (!meta) {
        clientMeta.set(ws, { sessionId: null, lastPong: now });
        return;
      }

      if (now - meta.lastPong > WS_HEARTBEAT_INTERVAL_MS * 2) {
        // Consider client disconnected after 40s without pong.
        leaveRoom(ws);
        try {
          ws.terminate();
        } catch (error) {
          logger.warn("Failed to terminate stale WebSocket client", {
            error,
          });
        }
        return;
      }

      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(
            JSON.stringify({
              type: "HEARTBEAT",
              timestamp: Date.now(),
            } satisfies WSMessage)
          );
        } catch (error) {
          logger.warn("Failed to send heartbeat to client", { error });
        }
      }
    });
  }, WS_HEARTBEAT_INTERVAL_MS);
}

/**
 * Singleton-style facade exposing WebSocket server functionality.
 * Other services should depend on this exported object rather than manipulating ws directly.
 */
export const WebSocketService = {
  init,
  handleConnection,
  emit,
  emitAll,
  startHeartbeat,
};

