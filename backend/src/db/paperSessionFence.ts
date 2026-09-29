import type { ClientSession, Connection } from "mongoose";
import { z } from "zod";
export const orchestrationRefSchema = z.object({ cycleId: z.string().regex(/^[a-f0-9]{64}$/),
  sessionId: z.string().min(1), startupId: z.string().min(1) }).strict();
/** These unique constraints are safety prerequisites, not optional query optimizations. */
export async function assertPaperHistoryIndexes(connection: Connection) {
  for (const [collection, key, partial] of [
    ["signal_logs", {cycleId:1}, {executionMode:"PAPER"}],
    ["monitoring_sessions", {accountId:1}, {executionMode:"PAPER",status:"RUNNING"}],
    ["monitoring_sessions", {sessionId:1}, {executionMode:"PAPER"}],
  ] as const) {
    const indexes = await connection.db!.collection(collection).listIndexes().toArray();
    const same = (a: Record<string,unknown>, b: Record<string,unknown>) =>
      Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k,v])=>b[k]===v);
    if (!indexes.some(i=>i.unique===true && !i.sparse && !i.hidden && same(i.key,key)
      && same(i.partialFilterExpression??{},partial))) throw new Error("PAPER_INDEXES_REQUIRED");
  }
}
/** Serialized with session stop; only pre-dispatch writes use this fence. */
export async function fencePaperSession(connection: Connection, session: ClientSession, accountId: string, input: unknown) {
  const ref = orchestrationRefSchema.parse(input);
  const cycle = await connection.db!.collection("signal_logs").findOne({ ...ref, accountId, executionMode: "PAPER" }, { session });
  if (!cycle || !["DECIDED", "ENTRY", "ATTENTION"].includes(cycle.outcome) || cycle.decision?.strategyResult?.action !== "CANDIDATE")
    throw new Error("DECISION_CONFLICT");
  const active = await connection.db!.collection("monitoring_sessions").updateOne({ sessionId: ref.sessionId,
    accountId, executionMode: "PAPER", startupId: ref.startupId, status: "RUNNING", configFingerprint: cycle.configFingerprint },
    { $inc: { cycleFence: 1 } }, { session });
  if (active.matchedCount !== 1) throw new Error("SESSION_STOPPED");
  return cycle;
}
