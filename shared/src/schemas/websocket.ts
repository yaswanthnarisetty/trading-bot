import { z } from "zod";
import { primarySignalSchema, type PrimarySignal } from "./signal";
import { verifierResultSchema, type VerifierResult } from "./verifier";
import {
  indicatorSnapshotSchema,
  type IndicatorSnapshot,
} from "./indicators";
import { greeksSnapshotSchema, type GreeksSnapshot } from "./greeks";
import { expiryContextSchema, type ExpiryContext } from "./expiry";
import { optionsPositionSchema, type OptionsPosition } from "./trade";

/**
 * Zod schema describing the payload for a real-time trading signal message.
 * This message is pushed over WebSocket to synchronize LLM decisions and analysis context.
 */
export const signalPayloadSchema = z.object({
  sessionId: z.string(),
  asset: z.string(),
  ltp: z.number(),
  signal: primarySignalSchema,
  verifierResult: verifierResultSchema.nullable(),
  riskAction: z.enum(["SUGGEST", "BLOCK"]),
  blockReason: z.string().nullable(),
  indicators: indicatorSnapshotSchema,
  greeksSnapshot: greeksSnapshotSchema.nullable(),
  expiryContext: expiryContextSchema,
  paperPnL: z.number(),
  openPositions: z.number(),
  dataMode: z.enum(["LIVE", "MOCK"]),
  timestamp: z.number(),
  /** S/R context — optional, present when SR data is available for the tick */
  srContext: z.unknown().optional(),
  /** Breakout detection result — optional, present when breakout analysis ran */
  breakoutResult: z.unknown().optional(),
});

export type SignalPayload = z.infer<typeof signalPayloadSchema>;

/**
 * Zod schemas for individual WebSocket message variants used between backend and frontend.
 * Every message carries a type discriminator to enable robust union parsing and validation.
 */
export const signalMessageSchema = z.object({
  type: z.literal("SIGNAL"),
  payload: signalPayloadSchema,
});

export type SignalMessage = z.infer<typeof signalMessageSchema>;

export const positionOpenedMessageSchema = z.object({
  type: z.literal("POSITION_OPENED"),
  payload: optionsPositionSchema,
});

export type PositionOpenedMessage = z.infer<typeof positionOpenedMessageSchema>;

export const positionClosedMessageSchema = z.object({
  type: z.literal("POSITION_CLOSED"),
  payload: optionsPositionSchema,
});

export type PositionClosedMessage = z.infer<typeof positionClosedMessageSchema>;

export const positionUpdatePayloadSchema = z.object({
  positionId: z.string(),
  currentPnL: z.number(),
  currentLTP: z.number(),
});

export type PositionUpdatePayload = z.infer<typeof positionUpdatePayloadSchema>;

export const positionUpdateMessageSchema = z.object({
  type: z.literal("POSITION_UPDATE"),
  payload: positionUpdatePayloadSchema,
});

export type PositionUpdateMessage = z.infer<typeof positionUpdateMessageSchema>;

export const sessionStartedPayloadSchema = z.object({
  sessionId: z.string(),
  asset: z.string(),
  paperCapital: z.number(),
});

export type SessionStartedPayload = z.infer<typeof sessionStartedPayloadSchema>;

export const sessionStartedMessageSchema = z.object({
  type: z.literal("SESSION_STARTED"),
  payload: sessionStartedPayloadSchema,
});

export type SessionStartedMessage = z.infer<typeof sessionStartedMessageSchema>;

export const sessionStoppedPayloadSchema = z.object({
  sessionId: z.string(),
  finalPnL: z.number(),
  totalTrades: z.number(),
});

export type SessionStoppedPayload = z.infer<typeof sessionStoppedPayloadSchema>;

export const sessionStoppedMessageSchema = z.object({
  type: z.literal("SESSION_STOPPED"),
  payload: sessionStoppedPayloadSchema,
});

export type SessionStoppedMessage = z.infer<typeof sessionStoppedMessageSchema>;

export const tickSkippedMessageSchema = z.object({
  type: z.literal("TICK_SKIPPED"),
  reason: z.string(),
  timestamp: z.number(),
});

export type TickSkippedMessage = z.infer<typeof tickSkippedMessageSchema>;

export const tickErrorMessageSchema = z.object({
  type: z.literal("TICK_ERROR"),
  error: z.string(),
  timestamp: z.number(),
});

export type TickErrorMessage = z.infer<typeof tickErrorMessageSchema>;

export const heartbeatMessageSchema = z.object({
  type: z.literal("HEARTBEAT"),
  timestamp: z.number(),
});

export type HeartbeatMessage = z.infer<typeof heartbeatMessageSchema>;

/**
 * Discriminated union Zod schema for all supported WebSocket messages.
 * This is the single source of truth for real-time protocol validation.
 */
export const wsMessageSchema = z.discriminatedUnion("type", [
  signalMessageSchema,
  positionOpenedMessageSchema,
  positionClosedMessageSchema,
  positionUpdateMessageSchema,
  sessionStartedMessageSchema,
  sessionStoppedMessageSchema,
  tickSkippedMessageSchema,
  tickErrorMessageSchema,
  heartbeatMessageSchema,
]);

export type WSMessage = z.infer<typeof wsMessageSchema>;

export type {
  PrimarySignal,
  VerifierResult,
  IndicatorSnapshot,
  GreeksSnapshot,
  ExpiryContext,
  OptionsPosition,
};

