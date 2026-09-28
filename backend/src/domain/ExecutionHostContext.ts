import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EntryRiskError } from "./entryRisk";

export interface ExecutionHostContext { readonly startupId: string }
const hosts = new WeakSet<object>();
const startupIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

/** Call ONCE at host/bootstrap startup, then inject the same context into services.
 * No timestamp, environment value or per-request identity. Explicit IDs are for tests. */
export function createExecutionHostContext(startupId: string = randomUUID()): ExecutionHostContext {
  const host = Object.freeze({ startupId: startupIdSchema.parse(startupId) });
  hosts.add(host);
  return host;
}
export function validateExecutionHost(host: ExecutionHostContext | undefined): void {
  if (host !== undefined && (!host || !hosts.has(host))) throw new Error("INVALID_EXECUTION_HOST_CONTEXT");
}
export function requireExecutionHost(host: ExecutionHostContext | undefined): ExecutionHostContext {
  validateExecutionHost(host);
  if (!host) throw new EntryRiskError("RECOVERY_REQUIRED");
  return host;
}
