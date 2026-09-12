const { rmSync, existsSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
rmSync(dist, { recursive: true, force: true });
const compiler = require.resolve("typescript/bin/tsc");
const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
if (result.status !== 0 || !existsSync(path.join(dist, "domain/ExecutionSafety.js"))) {
  rmSync(dist, { recursive: true, force: true });
  console.error("Backend build failed. Old/partial artifacts removed; start is blocked.");
  process.exit(result.status || 1);
}
