const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
test("npm start must cleanly build before loading the entry point", () => {
  const pkg = require(path.join(root, "package.json"));
  assert.equal(pkg.scripts.start, "npm run build && node dist/index.js");
  const builder = fs.readFileSync(path.join(root, "scripts/build.cjs"), "utf8");
  assert.ok(builder.indexOf("rmSync(dist") < builder.indexOf("spawnSync(process.execPath"));
  assert.ok(require(path.join(root, "tsconfig.build.json")).compilerOptions.noEmitOnError);
});
test("compiled Delta and crypto engine entry points enforce the disabled boundary", async () => {
  const safety = require(path.join(root, "dist/domain/ExecutionSafety.js"));
  assert.throws(safety.rejectDeltaExecution, /DELTA_EXECUTION_DISABLED/);
  const delta = require(path.join(root, "dist/services/DeltaService.js"));
  await assert.rejects(delta.placeOrder("buy", 1, "BTCUSD"), /DELTA_EXECUTION_DISABLED/);
  const monitor = require(path.join(root, "dist/services/CryptoMonitorService.js"));
  assert.throws(() => monitor.startCryptoEngine("test", 100), /DELTA_EXECUTION_DISABLED/);
  const routes = require(path.join(root, "dist/routes/crypto.js"));
  assert.equal(routes.cryptoRequestAllowed("GET", "/session/active"), false);
  assert.equal(routes.cryptoRequestAllowed("POST", "/session/start"), false);
  assert.equal(routes.cryptoRequestAllowed("GET", "/history"), true);
});
