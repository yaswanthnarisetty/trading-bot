import type { ClientSession } from "mongoose";
const authorized = new WeakSet<ClientSession>();
export const recoveryWriteAllowed = (session: ClientSession) => authorized.has(session);
export async function withRecoveryWrite<T>(session: ClientSession, work: () => Promise<T>): Promise<T> {
  authorized.add(session);
  try { return await work(); } finally { authorized.delete(session); }
}
