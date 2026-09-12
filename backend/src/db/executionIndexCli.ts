import mongoose from "mongoose";
import { requiredExecutionIndexes, verifyExecutionIndexes } from "./executionIndexes";
import { createExecutionIndexes } from "./executionModels";

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === "list") { console.log(JSON.stringify(requiredExecutionIndexes(), null, 2)); return; }
  if (!["verify", "provision"].includes(action)) throw new Error("Usage: execution:indexes list|verify|provision");
  const uri = process.env.EXECUTION_MONGO_URI;
  if (!uri) throw new Error("EXECUTION_MONGO_URI must explicitly select the database; application .env is never loaded");
  const connection = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await connection.asPromise();
    if (action === "provision") await createExecutionIndexes(connection);
    const result = await verifyExecutionIndexes(connection);
    console.log(JSON.stringify(result, null, 2));
    if (!result.verified) process.exitCode = 1;
  } finally { await connection.close(); }
}
if (require.main === module) void main().catch(() => { console.error("Execution index operation failed; check explicit URI, permissions and index conflicts. No indexes were replaced."); process.exitCode = 1; });
