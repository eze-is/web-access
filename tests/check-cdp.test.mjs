import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_CDP = path.join(ROOT, 'scripts', 'check-cdp.mjs');

test('check-cdp does not report a native proxy as extension ready', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      status: 'ok',
      backend: 'cdp-native',
      connected: true,
      chromePort: 9222,
    }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  try {
    const result = await runCheckCdp(port);
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.stdout, /cdp-extension: ready/);
    assert.match(result.stderr, /native proxy/i);
  } finally {
    server.close();
  }
});

function runCheckCdp(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHECK_CDP], {
      env: { ...process.env, CDP_PROXY_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => stdout += chunk);
    child.stderr.on('data', (chunk) => stderr += chunk);
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}
