import type { ClientSession } from "mongoose";
const writes = new WeakMap<ClientSession, string>();
export const candidateWriteAllowed = (session: ClientSession, fingerprint: string) => writes.get(session) === fingerprint;
export async function withCandidateWrite<T>(session: ClientSession, fingerprint: string, work: () => Promise<T>): Promise<T> {
  writes.set(session, fingerprint); try { return await work(); } finally { writes.delete(session); }
}
