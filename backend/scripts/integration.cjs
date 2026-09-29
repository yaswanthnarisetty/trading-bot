// Isolated real Mongo only. Never reads backend/.env or the application's MONGODB_URI.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { mongo: { MongoClient } } = require("mongoose");
const root = path.resolve(__dirname, "..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const directory = path.join(root, "tests/integration");
  const files = fs.existsSync(directory) ? fs.readdirSync(directory).filter(f => f.endsWith(".test.ts")
    && (!process.env.EXECUTION_TEST_FILE || f === process.env.EXECUTION_TEST_FILE)).map(f => path.join(directory, f)) : [];
  if (!files.length) throw new Error("NOT RUN: integration test files are missing");
  const database = `phase2a_test_${process.pid}_${Date.now()}`;
  let server, temporary, admin, child;
  try {
    let base = process.env.EXECUTION_TEST_MONGO_URI;
    if (!base) {
      const port = await new Promise((resolve, reject) => {
        const socket = net.createServer(); socket.on("error", reject);
        socket.listen(0, "127.0.0.1", () => { const address = socket.address(); socket.close(() => resolve(address.port)); });
      });
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), "phase2a-mongo-"));
      server = spawn("mongod", ["--dbpath", temporary, "--replSet", "phase2a", "--bind_ip", "127.0.0.1", "--port", String(port), "--logpath", path.join(temporary, "mongo.log")], { stdio: "ignore" });
      let startupError; server.on("error", error => { startupError = error; });
      base = `mongodb://127.0.0.1:${port}/?directConnection=true`;
      admin = new MongoClient(base, { serverSelectionTimeoutMS: 500 });
      let connected = false;
      for (let i = 0; i < 60; i++) {
        if (startupError || server.exitCode !== null) throw new Error("NOT RUN: local mongod unavailable; install/provide a replica-set test Mongo via EXECUTION_TEST_MONGO_URI");
        try { await admin.connect(); connected = true; break; } catch { await delay(200); }
      }
      if (!connected) throw new Error("NOT RUN: local Mongo did not start");
      await admin.db("admin").command({ replSetInitiate: { _id: "phase2a", members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
    } else { admin = await new MongoClient(base, { serverSelectionTimeoutMS: 5000 }).connect(); }
    let primary = false;
    for (let i = 0; i < 60; i++) {
      const hello = await admin.db("admin").command({ hello: 1 });
      if (hello.isWritablePrimary && (hello.setName || hello.msg === "isdbgrid")) { primary = true; break; }
      await delay(200);
    }
    if (!primary) throw new Error("NOT RUN: transaction-capable primary unavailable");
    const uri = new URL(base); uri.pathname = `/${database}`;
    console.log("Integration: real Mongo replica-set/sharded primary; isolated temporary test database.");
    child = spawn(process.execPath, ["--require", "ts-node/register", "--test", "--test-concurrency=1",
      ...(process.env.EXECUTION_TEST_PATTERN ? [`--test-name-pattern=${process.env.EXECUTION_TEST_PATTERN}`] : []), ...files], {
      cwd: root, stdio: "inherit", env: { ...process.env, TS_NODE_PROJECT: "tsconfig.test.json", EXECUTION_TEST_MONGO_URI: uri.toString() },
    });
    process.exitCode = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", code => resolve(code ?? 1)); });
  } finally {
    if (admin) { try { await admin.db(database).dropDatabase(); } finally { await admin.close(); } }
    if (server && server.exitCode === null && !server.killed) {
      await new Promise(resolve => { server.once("exit", resolve); server.kill("SIGTERM"); });
    }
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 2; });
