import type { ClientSession, Document } from "mongoose";
import type { ExecutionScope, TradingEvent, TradingEventType } from "@trading-bot/shared";
import type { executionModels } from "../db/executionModels";
import { requireAggregateVersion } from "../db/executionConcurrency";
export async function saveRisk(doc: Document, scope: ExecutionScope, session: ClientSession, now: Date) {
  requireAggregateVersion(doc, scope, doc.get("version"));
  if (doc.get("version") >= Number.MAX_SAFE_INTEGER) throw new Error("CAS_VERSION_EXHAUSTED");
  doc.set("updatedAt", now); await doc.save({ session });
}
export async function riskAudit(models: ReturnType<typeof executionModels>, scope: ExecutionScope, session: ClientSession, now: Date,
  event: { eventId: string; eventType: TradingEventType; causationId: string; reason: string; payload: TradingEvent["payload"];
    tradingDate: string; evidenceRefs: string[]; reservation?: Document }) {
  const account = await models.TradingAccount.findOne(scope).session(session).orFail();
  const sequence = account.get("nextEventSequence");
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) throw new Error("EVENT_SEQUENCE_EXHAUSTED");
  account.set("nextEventSequence", sequence + 1); await saveRisk(account, scope, session, now);
  const aggregate = event.reservation ?? account;
  await new models.TradingEvent({ ...scope, schemaVersion: 1, correlationId: aggregate.get("correlationId"), createdAt: now,
    eventId: event.eventId, eventType: event.eventType, accountSequence: sequence, tradingDate: event.tradingDate,
    aggregateType: event.reservation ? "RiskReservation" : "TradingAccount", aggregateId: aggregate.get(event.reservation ? "reservationId" : "accountId"),
    aggregateVersion: aggregate.get("version"), causationId: event.causationId, actor: "RiskLifecycle", reason: event.reason,
    occurredAt: now, recordedAt: now, evidenceRefs: event.evidenceRefs, payload: event.payload }).save({ session });
}
