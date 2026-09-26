import type { Connection } from "mongoose";
import { schemasForIndexGroup, type ExecutionIndexGroup } from "./executionModels";

export interface RequiredExecutionIndex {
  collection: string;
  key: Record<string, unknown>;
  options: Record<string, unknown>;
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
    const required = requiredExecutionIndexes(group);
    const inventory: Record<string, Record<string, unknown>[]> = {};
    for (const collection of new Set(required.map(s => s.collection))) {
      const exists = await connection.db.listCollections({ name: collection }, { nameOnly: true }).hasNext();
      inventory[collection] = exists ? await connection.db.collection(collection).listIndexes().toArray() : [];
    }
    const issues = compareExecutionIndexes(required, inventory);
    return { verified: issues.length === 0, issues };
  } catch { return { verified: false, issues: ["INDEX_VERIFICATION_FAILED"] }; }
}
export async function assertExecutionIndexes(connection: Connection, group: ExecutionIndexGroup = "BASE"): Promise<void> {
  const result = await verifyExecutionIndexes(connection, group);
  if (!result.verified) throw new Error(`EXECUTION_INDEXES_NOT_READY: ${result.issues.join("; ")}`);
}
