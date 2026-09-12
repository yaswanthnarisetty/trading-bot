export * from "./schemas/execution";
import { greeksSnapshotSchema, type GreeksSnapshot } from "./schemas/greeks";
import { indicatorSnapshotSchema, type IndicatorSnapshot } from "./schemas/indicators";
import { expiryContextSchema, type ExpiryContext } from "./schemas/expiry";
import { primarySignalSchema, type PrimarySignal } from "./schemas/signal";
import { verifierResultSchema, type VerifierResult } from "./schemas/verifier";
import { tradeLegSchema, optionsPositionSchema, type TradeLeg, type OptionsPosition } from "./schemas/trade";
import { cryptoPositionSchema, cryptoSignalSchema, type CryptoPosition, type CryptoSignal } from "./schemas/crypto";
import { monitoringSessionSchema, type MonitoringSession } from "./schemas/session";
import { wsMessageSchema, type WSMessage, signalPayloadSchema, type SignalPayload, signalMessageSchema, type SignalMessage, positionOpenedMessageSchema, type PositionOpenedMessage, positionClosedMessageSchema, type PositionClosedMessage, positionUpdatePayloadSchema, type PositionUpdatePayload, positionUpdateMessageSchema, type PositionUpdateMessage, sessionStartedPayloadSchema, type SessionStartedPayload, sessionStartedMessageSchema, type SessionStartedMessage, sessionStoppedPayloadSchema, type SessionStoppedPayload, sessionStoppedMessageSchema, type SessionStoppedMessage, tickSkippedMessageSchema, type TickSkippedMessage, tickErrorMessageSchema, type TickErrorMessage, heartbeatMessageSchema, type HeartbeatMessage } from "./schemas/websocket";
export { greeksSnapshotSchema, indicatorSnapshotSchema, expiryContextSchema, primarySignalSchema, verifierResultSchema, tradeLegSchema, optionsPositionSchema, monitoringSessionSchema, cryptoPositionSchema, cryptoSignalSchema, wsMessageSchema, signalPayloadSchema, signalMessageSchema, positionOpenedMessageSchema, positionClosedMessageSchema, positionUpdatePayloadSchema, positionUpdateMessageSchema, sessionStartedPayloadSchema, sessionStartedMessageSchema, sessionStoppedPayloadSchema, sessionStoppedMessageSchema, tickSkippedMessageSchema, tickErrorMessageSchema, heartbeatMessageSchema, };
export type { GreeksSnapshot, IndicatorSnapshot, ExpiryContext, PrimarySignal, VerifierResult, TradeLeg, OptionsPosition, MonitoringSession, CryptoPosition, CryptoSignal, WSMessage, SignalPayload, SignalMessage, PositionOpenedMessage, PositionClosedMessage, PositionUpdatePayload, PositionUpdateMessage, SessionStartedPayload, SessionStartedMessage, SessionStoppedPayload, SessionStoppedMessage, TickSkippedMessage, TickErrorMessage, HeartbeatMessage, };
/**
 * Parses and validates an incoming WebSocket message against the shared WSMessage schema.
 * This central helper ensures all WS payloads are strongly typed and will throw a ZodError on invalid shape.
 *
 * @param raw - The raw data received from the WebSocket layer, already deserialized into an unknown value.
 * @returns A strongly typed WSMessage instance if validation succeeds.
 * @throws z.ZodError if validation fails, signaling callers to treat the event as a HOLD or error condition.
 */
export declare function parseWSMessage(raw: unknown): WSMessage;
//# sourceMappingURL=index.d.ts.map