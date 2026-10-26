import type { ClientSession, Connection } from "mongoose";
import { schemasForIndexGroup, type ExecutionIndexGroup } from "./executionModels";

export interface RequiredExecutionIndex {
  collection: string;
  key: Record<string, unknown>;
  options: Record<string, unknown>;
}
export interface VerifiedExecutionIndexes { readonly verifiedAt: number }
const verifiedProofs = new WeakMap<VerifiedExecutionIndexes, { connection: Connection; group: ExecutionIndexGroup }>();
type ScopedProofs = { connection: Connection; proofs: Partial<Record<ExecutionIndexGroup, VerifiedExecutionIndexes>>;
  accountFences: Map<string, Record<string, unknown>> };
const scopedProofs = new WeakMap<ClientSession, ScopedProofs>();
/** Reuse only an issued, unexpired proof during one explicit financial operation.
 * The scope is removed even when the transaction aborts. Other writes still verify indexes.
 */
export async function withExecutionIndexProofs<T>(connection: Connection, session: ClientSession,
  proofs: Partial<Record<ExecutionIndexGroup, VerifiedExecutionIndexes>>, work: () => Promise<T>): Promise<T> {
  const previous = scopedProofs.get(session);
  if (previous && previous.connection !== connection) throw new Error("EXECUTION_INDEX_PROOF_CONNECTION_CONFLICT");
  scopedProofs.set(session, { connection, proofs, accountFences: new Map() });
  try { return await work(); }
  finally { if (previous) scopedProofs.set(session, previous); else scopedProofs.delete(session); }
}
/** The first account CAS in a transaction holds its write conflict until commit.
 * Only that same, explicitly scoped transaction can reuse the resulting account
 * snapshot for subsequent ledger validations. The scope is cleared on retry/end.
 */
export function executionAccountFenceFor(connection: Connection, session: ClientSession,
  key: string): Record<string, unknown> | undefined {
  const scoped = scopedProofs.get(session);
  if (!session.inTransaction() || scoped?.connection !== connection || !hasVerifiedExecutionIndexes(connection, scoped.proofs.BASE)) return;
  return scoped.accountFences.get(key);
}
export function rememberExecutionAccountFence(connection: Connection, session: ClientSession,
  key: string, account: Record<string, unknown>): void {
  const scoped = scopedProofs.get(session);
  if (session.inTransaction() && scoped?.connection === connection && hasVerifiedExecutionIndexes(connection, scoped.proofs.BASE))
    scoped.accountFences.set(key, account);
}
export function clearExecutionAccountFence(connection: Connection, session: ClientSession, key: string): void {
  const scoped = scopedProofs.get(session);
  if (scoped?.connection === connection) scoped.accountFences.delete(key);
}
export function executionIndexProofFor(connection: Connection, session: ClientSession,
  group: ExecutionIndexGroup = "BASE"): VerifiedExecutionIndexes | undefined {
  const scoped = scopedProofs.get(session);
  const proof = scoped?.connection === connection ? scoped.proofs[group] : undefined;
  return hasVerifiedExecutionIndexes(connection, proof, group) ? proof : undefined;
}
/** A recent, process-local result can be shared within one entry cycle. Callers
 * cannot mint a proof or reuse one for another database/index group. */
export function hasVerifiedExecutionIndexes(connection: Connection, proof: VerifiedExecutionIndexes | undefined,
  group: ExecutionIndexGroup = "BASE"): boolean {
  const issued = proof && verifiedProofs.get(proof);
  return !!issued && issued.connection === connection && issued.group === group
    && connection.readyState === 1 && Date.now() >= proof!.verifiedAt && Date.now() - proof!.verifiedAt <= 60_000;
}
export function requiredExecutionIndexes(group: ExecutionIndexGroup = "BASE"): RequiredExecutionIndex[] {
  return Object.values(schemasForIndexGroup(group)).flatMap(schema => schema.indexes().map(([key, options]) => ({
    collection: String(schema.get("collection")), key: { ...key }, options: { ...options },
  })));
}
function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Index names/background options are immaterial; compound key order and constraints are not. */
export function compareExecutionIndexes(required: RequiredExecutionIndex[], inventory: Record<string, Record<string, unknown>[]>): string[] {
  const issues: string[] = [];
  for (const spec of required) {
    const candidates = (inventory[spec.collection] ?? []).filter(index => JSON.stringify(index.key) === JSON.stringify(spec.key));
    const matches = candidates.some(index => Boolean(index.unique) === Boolean(spec.options.unique)
      && Boolean(index.sparse) === Boolean(spec.options.sparse)
      && canonical(index.partialFilterExpression) === canonical(spec.options.partialFilterExpression)
      && canonical(index.expireAfterSeconds) === canonical(spec.options.expireAfterSeconds)
      && canonical(index.collation) === canonical(spec.options.collation));
    if (!matches) issues.push(`${candidates.length ? "CONFLICTING" : "MISSING"}: ${spec.collection} ${JSON.stringify(spec.key)}`);
  }
  return issues;
}
export async function verifyExecutionIndexes(connection: Connection, group: ExecutionIndexGroup = "BASE"): Promise<{ verified: boolean; issues: string[] }> {
  if (connection.readyState !== 1 || !connection.db) return { verified: false, issues: ["DISCONNECTED"] };
  try {
    const db = connection.db;
    const required = requiredExecutionIndexes(group);
    const entries = await Promise.all([...new Set(required.map(s => s.collection))].map(async collection => {
      const exists = await db.listCollections({ name: collection }, { nameOnly: true }).hasNext();
      const indexes = exists ? await db.collection(collection).listIndexes().toArray() : [];
      return [collection, indexes] as const;
    }));
    const inventory = Object.fromEntries(entries) as Record<string, Record<string, unknown>[]>;
    const issues = compareExecutionIndexes(required, inventory);
    return { verified: issues.length === 0, issues };
  } catch { return { verified: false, issues: ["INDEX_VERIFICATION_FAILED"] }; }
}
export async function assertExecutionIndexes(connection: Connection, group: ExecutionIndexGroup = "BASE"): Promise<VerifiedExecutionIndexes> {
  const result = await verifyExecutionIndexes(connection, group);
  if (!result.verified) throw new Error(`EXECUTION_INDEXES_NOT_READY: ${result.issues.join("; ")}`);
  const proof = Object.freeze({ verifiedAt: Date.now() });
  verifiedProofs.set(proof, { connection, group });
  return proof;
}
