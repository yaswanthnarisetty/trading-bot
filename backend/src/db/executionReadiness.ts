import type { ClientSession, Connection } from "mongoose";
import { verifyExecutionIndexes } from "./executionIndexes";

export type TransactionCapability =
  | { supported: true; reason: "SNAPSHOT_TRANSACTION_VERIFIED" }
  | { supported: false; reason: "DISCONNECTED" | "UNSUPPORTED_TOPOLOGY" | "PROBE_FAILED" };

export function isTransactionTopology(hello: { setName?: string; msg?: string; logicalSessionTimeoutMinutes?: number; maxWireVersion?: number }): boolean {
  return (typeof hello.setName === "string" && hello.setName.length > 0 || hello.msg === "isdbgrid")
    && typeof hello.logicalSessionTimeoutMinutes === "number"
    && typeof hello.maxWireVersion === "number" && hello.maxWireVersion >= 7;
}

/** Explicit opt-in, read-only snapshot transaction probe; never called by app bootstrap. */
export async function checkTransactionCapability(connection: Connection): Promise<TransactionCapability> {
  if (connection.readyState !== 1 || !connection.db) return { supported: false, reason: "DISCONNECTED" };
  let session: ClientSession | undefined;
  try {
    const hello = await connection.db.admin().command({ hello: 1, maxTimeMS: 2000 });
    if (!isTransactionTopology(hello)) return { supported: false, reason: "UNSUPPORTED_TOPOLOGY" };
    session = await connection.startSession();
    session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    await connection.db.collection("execution_accounts").findOne({}, { session, maxTimeMS: 2000 });
    await session.abortTransaction();
    return { supported: true, reason: "SNAPSHOT_TRANSACTION_VERIFIED" };
  } catch {
    return { supported: false, reason: "PROBE_FAILED" };
  } finally {
    if (session) await session.endSession();
  }
}

/** A topology result alone is never an execution permit (including after reconnect). */
export function foundationReadiness(capability: TransactionCapability): { ready: false; reason: string } {
  return { ready: false, reason: capability.supported ? "PHASE_2A_EXECUTION_DISABLED" : capability.reason };
}

/** Read-only operational report; write/commit capability is proved separately by integration tests. */
export async function inspectExecutionReadiness(connection: Connection) {
  const capability = await checkTransactionCapability(connection);
  const indexes = await verifyExecutionIndexes(connection);
  return { connectionAvailable: connection.readyState === 1, transactionCapability: capability,
    indexes, transactionWriteCommit: "NOT VERIFIED" as const,
    ready: false as const, reason: !indexes.verified ? "EXECUTION_INDEXES_NOT_READY" : foundationReadiness(capability).reason };
}

export function requireExecutionTransaction(connection: Connection, session?: ClientSession): asserts session is ClientSession {
  if (connection.readyState !== 1 || !session || session.hasEnded || !session.inTransaction() || !("client" in session) || session.client !== connection.getClient()) {
    throw new Error("PERSISTENCE_NOT_READY: connected database and active transaction required");
  }
}
