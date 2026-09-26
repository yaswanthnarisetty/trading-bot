import type { ClientSession, Connection, Document } from "mongoose";
import type { ExecutionScope } from "@trading-bot/shared";
import { sameExecutionChain } from "../domain/execution";
import { executionModels, type ExecutionEntity } from "./executionModels";
import { requireExecutionTransaction } from "./executionReadiness";

export const entityIdFields = {
  ReconciliationRecord: "recordId", ReconciliationLink: "linkId",
  TradingAccount: "accountId", StrategySignal: "signalId", OrderIntent: "intentId",
  RiskReservation: "reservationId", BrokerOrder: "orderId", Fill: "fillId", Position: "positionId", TradingEvent: "eventId",
} as const satisfies Record<ExecutionEntity, string>;

/** Financial callers must declare the expected version before a versioned save. */
export function requireAggregateVersion(document: Document, scope: ExecutionScope, expectedVersion: number): void {
  if (!sameExecutionChain(scope, { accountId: document.get("accountId"), executionMode: document.get("executionMode") })) {
    throw new Error("MODE_MISMATCH");
  }
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || document.get("version") !== expectedVersion) {
    throw new Error("CAS_CONFLICT");
  }
}

/** Resolve relationships within the SAME account and transaction, never by a naked ID. */
export async function loadExecutionChain(connection: Connection, session: ClientSession, scope: ExecutionScope,
  references: readonly { entity: ExecutionEntity; id: string }[]): Promise<Document[]> {
  requireExecutionTransaction(connection, session);
  if (!sameExecutionChain(scope)) throw new Error("MODE_MISMATCH");
  const models = executionModels(connection);
  const account = await models.TradingAccount.findOne({ ...scope }).session(session);
  if (!account) throw new Error("ACCOUNT_NOT_FOUND");
  const records: Document[] = [account];
  // Keep reads sequential within the transaction (no Promise.all on a Mongo session).
  for (const reference of references) {
    const record = await models[reference.entity].findOne({ ...scope, [entityIdFields[reference.entity]]: reference.id }).session(session);
    if (!record) throw new Error("EXECUTION_REFERENCE_NOT_FOUND_IN_LEDGER");
    records.push(record);
  }
  return records;
}
