import test from "node:test";
import assert from "node:assert/strict";
import { cryptoRequestAllowed } from "../../src/routes/crypto";
import { placeOrder } from "../../src/services/DeltaService";
import { startCryptoEngine, checkCryptoPositions, forceCloseAllCryptoPositions } from "../../src/services/CryptoMonitorService";
import { openCryptoPosition, closeCryptoPosition } from "../../src/services/CryptoTradingService";

test("crypto gate blocks all execution/mutation and GET restart routes", () => {
  for (const [method, path] of [["POST", "/session/start"], ["POST", "/session/stop"], ["GET", "/session/active"],
    ["PATCH", "/positions/p/close"], ["POST", "/history"], ["GET", "/future-execution-route"]]) assert.equal(cryptoRequestAllowed(method, path), false);
});
test("crypto gate preserves only known read-only handlers", () => {
  for (const path of ["/status", "/price", "/history", "/positions/s", "/positions/s/open", "/pnl/s", "/signals/s"]) assert.equal(cryptoRequestAllowed("GET", path), true);
});
test("direct crypto execution functions reject before broker or persistence access", async () => {
  assert.throws(() => startCryptoEngine("test", 100), /DELTA_EXECUTION_DISABLED/);
  await assert.rejects(checkCryptoPositions("test"), /DELTA_EXECUTION_DISABLED/);
  await assert.rejects(openCryptoPosition("test", "LONG", 100, 100, 1), /DELTA_EXECUTION_DISABLED/);
  await assert.rejects(closeCryptoPosition("test", 100, "MANUAL"), /DELTA_EXECUTION_DISABLED/);
  await assert.rejects(forceCloseAllCryptoPositions("test"), /DELTA_EXECUTION_DISABLED/);
  await assert.rejects(placeOrder("buy", 1, "BTCUSD"), /DELTA_EXECUTION_DISABLED/);
});
