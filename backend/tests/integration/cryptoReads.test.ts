import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { CryptoPositionModel } from "../../src/models/CryptoPosition";
import { getCryptoPositionHistory, getOpenCryptoPositions, getCryptoDailyPnL } from "../../src/services/CryptoTradingService";

const uri = process.env.EXECUTION_TEST_MONGO_URI;
if (!uri || !new URL(uri).pathname.startsWith("/phase2a_test_")) throw new Error("NOT RUN: isolated test Mongo required");
before(async () => { await mongoose.connect(uri); });
after(async () => { await mongoose.disconnect(); });
test("stored crypto history, positions and daily P&L remain readable without execution", async () => {
  const timestamp = new Date().toISOString();
  await CryptoPositionModel.create({ positionId: "read-only-test", sessionId: "read-only-session", asset: "BTCUSD", side: "LONG",
    entryPrice: 100, exitPrice: 110, size: 1, entryTimestamp: timestamp, exitTimestamp: timestamp,
    stopLoss: 90, takeProfit: 110, realizedPnL: 10, status: "CLOSED", dataMode: "MOCK", exitReason: "MANUAL" });
  assert.equal((await getCryptoPositionHistory("read-only-session"))[0].positionId, "read-only-test");
  assert.deepEqual(await getOpenCryptoPositions("read-only-session"), []);
  assert.equal(await getCryptoDailyPnL("read-only-session"), 10);
});
