import type { ClientSession } from "mongoose";
// Transaction-scoped capability, following the audited risk-control boundaries.
const authorized = new WeakSet<ClientSession>();
export const reconciliationWriteAllowed = (session: ClientSession) => authorized.has(session);
export async function withReconciliationWrite<T>(session: ClientSession, work: () => Promise<T>): Promise<T> {
  authorized.add(session);
  try { return await work(); } finally { authorized.delete(session); }
}
