// Explicit offline end-to-end smoke, on the same isolated real-Mongo runner.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const result = spawnSync(process.execPath, [path.join(__dirname, 'integration.cjs')], {
  stdio: 'inherit', env: { ...process.env, EXECUTION_TEST_FILE: 'paperExits.test.ts', EXECUTION_TEST_PATTERN: '^OFFLINE_EXIT_SMOKE ' },
});
if (result.error) { console.error('Offline PAPER smoke could not start'); process.exitCode = 2; }
else process.exitCode = result.status ?? 1;
