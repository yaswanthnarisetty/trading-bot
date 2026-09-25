import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Connection, Document, ClientSession } from "mongoose";
import type { ExecutionScope } from "@trading-bot/shared";
import { executionModels } from "../src/db/executionModels";
import { brokerOrderRequestSchema, type BrokerOrderRequest } from "../src/brokers/BrokerAdapter";
import { submissionFingerprint, type SubmissionEvidence } from "../src/brokers/submissionEvidence";
import { PaperBrokerAdapter } from "../src/brokers/PaperBrokerAdapter";
import { OrderManager, type SubmissionState } from "../src/services/OrderManager";

/** Test data only: restore the already-dispatched boundary of a pre-2C1 ENTRY.
 * Historical SELL/spread/fill fixtures cannot be freshly admitted by 2C1. Native
 * fixture restoration is explicit; production admission is neither mocked nor
 * disabled. Actual simulator evidence still passes the real persistence/FillProcessor
 * paths. This helper is never used by initial-submission or admission tests.
 */
export async function restoreHistoricalEntryClaim(connection: Connection, scope: ExecutionScope,
  broker: PaperBrokerAdapter, clock: () => Date, orderId: string): Promise<{ request: BrokerOrderRequest }> {
  assert.ok(connection.name.startsWith("phase2a_test_"), "isolated test database required");
  const models = executionModels(connection), session = await connection.startSession();
  try {
    return await session.withTransaction(async () => {
      const order = await models.BrokerOrder.findOne({ ...scope, orderId }).session(session).orFail();
      const intent = await models.OrderIntent.findOne({ ...scope, intentId: order.get("intentId") }).session(session).orFail();
      const authorization = order.get("submissionAuthorization");
      const reservation = await models.RiskReservation.findOne({ ...scope, reservationId: authorization.reservationId }).session(session).orFail();
      assert.equal(intent.get("purpose"), "ENTRY"); assert.equal(intent.get("entryPlan"), undefined);
      assert.equal(reservation.get("kind"), undefined); assert.equal(order.get("phase"), "READY");
      assert.equal(order.get("submissionClaim"), undefined);
      const request = brokerOrderRequestSchema.parse({ ...scope, orderId, claimId: randomUUID(),
        intentId: intent.get("intentId"), positionId: order.get("positionId"), legId: order.get("legId"),
        contractKey: order.get("contractKey"), side: order.get("side"), quantityUnits: order.get("quantityUnits"),
        orderType: "LIMIT", limitPriceMinor: order.get("limitPriceMinor"), product: authorization.product });
      const restored = await connection.db!.collection("execution_orders").updateOne({ ...scope, orderId, version: order.get("version") }, {
        $set: { phase: "SUBMITTING", submissionClaim: { claimId: request.claimId, reservationId: authorization.reservationId,
          evidenceRef: authorization.evidenceRef, policyVersion: authorization.policyVersion, executionEpoch: authorization.executionEpoch,
          claimedAt: clock(), expiresAt: authorization.expiresAt, request, requestFingerprint: submissionFingerprint(request) } }, $inc: { version: 1 },
      }, { session });
      assert.equal(restored.modifiedCount, 1);
      intent.set("state", "EXECUTING"); await intent.save({ session });
      const restoredOrder = await models.BrokerOrder.findOne({ ...scope, orderId }).session(session).orFail();
      const manager = new OrderManager(connection, scope, broker, clock) as unknown as {
        audit(order: Document, type: "SUBMISSION_CLAIMED", from: string, evidence: string, session: ClientSession): Promise<void>;
      };
      await manager.audit(restoredOrder, "SUBMISSION_CLAIMED", "READY", authorization.evidenceRef, session);
      return { request };
    });
  } finally { await session.endSession(); }
}

export async function recordHistoricalEntryOutcome(connection: Connection, scope: ExecutionScope,
  broker: PaperBrokerAdapter, clock: () => Date, orderId: string) {
  const { request } = await restoreHistoricalEntryClaim(connection, scope, broker, clock, orderId);
  const manager = new OrderManager(connection, scope, broker, clock) as unknown as {
    collect(request: BrokerOrderRequest): Promise<SubmissionEvidence>;
    persist(orderId: string, request: BrokerOrderRequest, evidence: SubmissionEvidence): Promise<SubmissionState>;
  };
  const evidence = await manager.collect(request);
  return { status: "PERSISTED" as const, order: await manager.persist(orderId, request, evidence) };
}
