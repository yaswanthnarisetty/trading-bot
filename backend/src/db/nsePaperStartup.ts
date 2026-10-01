import type { Connection } from "mongoose";
import { createExecutionIndexes } from "./executionModels";
import { assertExecutionIndexes } from "./executionIndexes";
import { ensureNsePaperAccount } from "../services/NsePaperAccountService";

/** Startup ordering for the reconciliation-enabled PAPER:NSE account. */
export async function bootstrapNsePaperAccount(connection: Connection,
  ensureAccount: (connection: Connection) => Promise<void> = ensureNsePaperAccount): Promise<void> {
  await createExecutionIndexes(connection, "ALL");
  await assertExecutionIndexes(connection, "ALL");
  await ensureAccount(connection);
}
