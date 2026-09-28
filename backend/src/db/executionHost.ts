import type { ClientSession } from "mongoose";
import { validateExecutionHost, type ExecutionHostContext } from "../domain/ExecutionHostContext";

// Carries construction-time identity to mandatory save middleware, not readiness.
// Durable account + reconciliation + event proof remains the authority.
const hosts = new WeakMap<ClientSession, ExecutionHostContext>();
export const executionHostFor = (session: ClientSession) => hosts.get(session);
export async function withExecutionHost<T>(session: ClientSession, host: ExecutionHostContext | undefined, work: () => Promise<T>): Promise<T> {
  validateExecutionHost(host);
  const previous = hosts.get(session);
  if (previous && previous !== host) throw new Error("EXECUTION_HOST_CONTEXT_CONFLICT");
  if (host) hosts.set(session, host);
  try { return await work(); } finally { if (previous) hosts.set(session, previous); else hosts.delete(session); }
}
