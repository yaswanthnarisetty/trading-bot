import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import fs from "node:fs";
import path from "node:path";
import { checkTransactionCapability, foundationReadiness, isTransactionTopology, requireExecutionTransaction } from "../../src/db/executionReadiness";

test("INV-038 disconnected Mongo never passes readiness and never buffers execution writes", async () => {
  const connection = mongoose.createConnection();
  const capability = await checkTransactionCapability(connection);
  assert.deepEqual(capability, { supported: false, reason: "DISCONNECTED" });
  assert.equal(foundationReadiness(capability).ready, false);
  assert.throws(() => requireExecutionTransaction(connection), /PERSISTENCE_NOT_READY/);
  assert.equal(foundationReadiness({ supported: true, reason: "SNAPSHOT_TRANSACTION_VERIFIED" }).ready, false);
});

test("topology evidence is explicit; standalone and missing session support fail closed", () => {
  assert.equal(isTransactionTopology({ maxWireVersion: 21, logicalSessionTimeoutMinutes: 30 }), false);
  assert.equal(isTransactionTopology({ setName: "rs", maxWireVersion: 21 }), false);
  assert.equal(isTransactionTopology({ setName: "rs", maxWireVersion: 21, logicalSessionTimeoutMinutes: 30 }), true);
  assert.equal(isTransactionTopology({ msg: "isdbgrid", maxWireVersion: 21, logicalSessionTimeoutMinutes: 30 }), true);
});

test("INV-033 pure domain and transaction foundation have no external action callbacks or broker dependencies", () => {
  const src = path.resolve(__dirname, "../../src");
  for (const directory of ["domain", "db"]) {
    const files = fs.readdirSync(path.join(src, directory)).filter(name => name.endsWith(".ts") && (directory === "domain" || name.startsWith("execution")));
    for (const file of files) {
      const source = fs.readFileSync(path.join(src, directory, file), "utf8");
      assert.doesNotMatch(source, /from ["'].*(?:KiteService|DeltaService|LLMService|axios|openai)["']/);
      assert.doesNotMatch(source, /\bfetch\s*\(|\.withTransaction\s*\(/);
      if (directory === "domain") assert.doesNotMatch(source, /Date\.now\s*\(|new Date\s*\(\s*\)|process\.env|setInterval\s*\(/);
    }
  }
  const app = fs.readFileSync(path.join(src, "index.ts"), "utf8");
  assert.doesNotMatch(app, /executionModels|createExecutionIndexes|OrderStateMachine/);
  for (const service of ["SignalLoopService.ts", "PaperTradeService.ts"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(src, "services", service), "utf8"), /executionModels|OrderStateMachine|execution_intents/);
  }
});
