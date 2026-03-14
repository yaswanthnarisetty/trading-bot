"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.heartbeatMessageSchema = exports.tickErrorMessageSchema = exports.tickSkippedMessageSchema = exports.sessionStoppedMessageSchema = exports.sessionStoppedPayloadSchema = exports.sessionStartedMessageSchema = exports.sessionStartedPayloadSchema = exports.positionUpdateMessageSchema = exports.positionUpdatePayloadSchema = exports.positionClosedMessageSchema = exports.positionOpenedMessageSchema = exports.signalMessageSchema = exports.signalPayloadSchema = exports.wsMessageSchema = exports.cryptoSignalSchema = exports.cryptoPositionSchema = exports.monitoringSessionSchema = exports.optionsPositionSchema = exports.tradeLegSchema = exports.verifierResultSchema = exports.primarySignalSchema = exports.expiryContextSchema = exports.indicatorSnapshotSchema = exports.greeksSnapshotSchema = void 0;
exports.parseWSMessage = parseWSMessage;
const greeks_1 = require("./schemas/greeks");
Object.defineProperty(exports, "greeksSnapshotSchema", { enumerable: true, get: function () { return greeks_1.greeksSnapshotSchema; } });
const indicators_1 = require("./schemas/indicators");
Object.defineProperty(exports, "indicatorSnapshotSchema", { enumerable: true, get: function () { return indicators_1.indicatorSnapshotSchema; } });
const expiry_1 = require("./schemas/expiry");
Object.defineProperty(exports, "expiryContextSchema", { enumerable: true, get: function () { return expiry_1.expiryContextSchema; } });
const signal_1 = require("./schemas/signal");
Object.defineProperty(exports, "primarySignalSchema", { enumerable: true, get: function () { return signal_1.primarySignalSchema; } });
const verifier_1 = require("./schemas/verifier");
Object.defineProperty(exports, "verifierResultSchema", { enumerable: true, get: function () { return verifier_1.verifierResultSchema; } });
const trade_1 = require("./schemas/trade");
Object.defineProperty(exports, "tradeLegSchema", { enumerable: true, get: function () { return trade_1.tradeLegSchema; } });
Object.defineProperty(exports, "optionsPositionSchema", { enumerable: true, get: function () { return trade_1.optionsPositionSchema; } });
const crypto_1 = require("./schemas/crypto");
Object.defineProperty(exports, "cryptoPositionSchema", { enumerable: true, get: function () { return crypto_1.cryptoPositionSchema; } });
Object.defineProperty(exports, "cryptoSignalSchema", { enumerable: true, get: function () { return crypto_1.cryptoSignalSchema; } });
const session_1 = require("./schemas/session");
Object.defineProperty(exports, "monitoringSessionSchema", { enumerable: true, get: function () { return session_1.monitoringSessionSchema; } });
const websocket_1 = require("./schemas/websocket");
Object.defineProperty(exports, "wsMessageSchema", { enumerable: true, get: function () { return websocket_1.wsMessageSchema; } });
Object.defineProperty(exports, "signalPayloadSchema", { enumerable: true, get: function () { return websocket_1.signalPayloadSchema; } });
Object.defineProperty(exports, "signalMessageSchema", { enumerable: true, get: function () { return websocket_1.signalMessageSchema; } });
Object.defineProperty(exports, "positionOpenedMessageSchema", { enumerable: true, get: function () { return websocket_1.positionOpenedMessageSchema; } });
Object.defineProperty(exports, "positionClosedMessageSchema", { enumerable: true, get: function () { return websocket_1.positionClosedMessageSchema; } });
Object.defineProperty(exports, "positionUpdatePayloadSchema", { enumerable: true, get: function () { return websocket_1.positionUpdatePayloadSchema; } });
Object.defineProperty(exports, "positionUpdateMessageSchema", { enumerable: true, get: function () { return websocket_1.positionUpdateMessageSchema; } });
Object.defineProperty(exports, "sessionStartedPayloadSchema", { enumerable: true, get: function () { return websocket_1.sessionStartedPayloadSchema; } });
Object.defineProperty(exports, "sessionStartedMessageSchema", { enumerable: true, get: function () { return websocket_1.sessionStartedMessageSchema; } });
Object.defineProperty(exports, "sessionStoppedPayloadSchema", { enumerable: true, get: function () { return websocket_1.sessionStoppedPayloadSchema; } });
Object.defineProperty(exports, "sessionStoppedMessageSchema", { enumerable: true, get: function () { return websocket_1.sessionStoppedMessageSchema; } });
Object.defineProperty(exports, "tickSkippedMessageSchema", { enumerable: true, get: function () { return websocket_1.tickSkippedMessageSchema; } });
Object.defineProperty(exports, "tickErrorMessageSchema", { enumerable: true, get: function () { return websocket_1.tickErrorMessageSchema; } });
Object.defineProperty(exports, "heartbeatMessageSchema", { enumerable: true, get: function () { return websocket_1.heartbeatMessageSchema; } });
/**
 * Parses and validates an incoming WebSocket message against the shared WSMessage schema.
 * This central helper ensures all WS payloads are strongly typed and will throw a ZodError on invalid shape.
 *
 * @param raw - The raw data received from the WebSocket layer, already deserialized into an unknown value.
 * @returns A strongly typed WSMessage instance if validation succeeds.
 * @throws z.ZodError if validation fails, signaling callers to treat the event as a HOLD or error condition.
 */
function parseWSMessage(raw) {
    return websocket_1.wsMessageSchema.parse(raw);
}
