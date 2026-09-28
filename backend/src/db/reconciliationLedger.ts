import type { ClientSession, Connection } from "mongoose";
import type { ExecutionScope } from "@trading-bot/shared";
import type { ReconciliationLink } from "../domain/reconciliation";

/** Shared exact read set for comparison and recovery completion. Sequential session reads. */
export async function loadReconciliationLedger(connection: Connection, session: ClientSession, scope: ExecutionScope) {
  if (!connection.db) throw new Error("PERSISTENCE_NOT_READY");
  const read = (collection: string, key: string) => connection.db!.collection(collection).find(scope, { session }).sort({ [key]: 1 }).toArray();
  const orders = await read("execution_orders", "orderId");
  const fills = await read("execution_fills", "fillId");
  const positions = await read("execution_positions", "positionId");
  const links = await read("execution_reconciliation_links", "linkId");
  return { orders, fills, positions, links: links as unknown as ReconciliationLink[] };
}
