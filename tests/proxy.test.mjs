import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Use the same direct HTTP transport as the MCP server. Node 24's fetch/Undici
// may fail in macOS socket QoS setup before a proxy request reaches the server.
function proxyRequest(url, { method = 'GET', body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method, signal, timeout: 5_000, agent: false,
      headers: body === undefined ? undefined : {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode,
        json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('Proxy fixture request timed out')));
    request.end(body);
  });
}

test('proxy retries a closed handshake and shares concurrent connection attempts', { timeout: 15_000 }, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'web-access-proxy-test-'));
  t.after(() => {
    assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const chrome = net.createServer(socket => socket.end());
  chrome.listen(0, '127.0.0.1');
  await once(chrome, 'listening');
  t.after(() => chrome.close());
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const profile = process.platform === 'darwin'
    ? 'Library/Application Support/Google/Chrome'
    : process.platform === 'win32' ? 'Google/Chrome/User Data' : '.config/google-chrome';
  fs.mkdirSync(path.join(base, profile), { recursive: true });
  fs.writeFileSync(path.join(base, profile, 'DevToolsActivePort'), `${chrome.address().port}\n/devtools/browser/test\n`);
  const mock = path.join(base, 'mock.mjs');
  const closed = path.join(base, 'closed');
  fs.writeFileSync(mock, `
import fs from 'node:fs';
let attempts = 0;
globalThis.WebSocket = class extends EventTarget {
  static OPEN = 1;
  readyState = 0;
  constructor() {
    super();
    const attempt = ++attempts;
    setTimeout(() => {
      this.readyState = attempt === 1 ? 3 : 1;
      this.dispatchEvent(new Event(attempt === 1 ? 'close' : 'open'));
      if (attempt === 1) fs.writeFileSync(process.env.WEB_ACCESS_TEST_CLOSED, 'closed');
    }, 150);
  }
  send(raw) {
    const { id } = JSON.parse(raw);
    const event = new Event('message');
    event.data = JSON.stringify({ id, result: { targetInfos: [{ type: 'page', targetId: String(attempts), title: 'fixture', url: 'about:blank' }] } });
    this.dispatchEvent(event);
  }
};
`);
  const script = process.env.WEB_ACCESS_PROXY_SCRIPT || fileURLToPath(new URL('../scripts/cdp-proxy.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--import', pathToFileURL(mock).href, script, '--browser', 'chrome'], {
    env: { ...process.env, HOME: base, USERPROFILE: base, LOCALAPPDATA: base, CDP_PROXY_PORT: String(port), WEB_ACCESS_TEST_CLOSED: closed },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5_000;
  while (true) {
    try { await proxyRequest(`${endpoint}/health`); break; } catch {
      assert.ok(Date.now() < deadline, `proxy starts: ${errors}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  // The startup handshake closes before open. Later requests must start a fresh attempt.
  while (!fs.existsSync(closed)) {
    assert.ok(Date.now() < deadline, 'startup handshake closes');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const results = await Promise.all(Array.from({ length: 8 }, async () => {
    const response = await proxyRequest(`${endpoint}/targets`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(response.status, 200);
    return response.json();
  }));
  for (const targets of results) assert.equal(targets[0].targetId, '2', 'one retry serves all concurrent callers');
  assert.equal((await (await proxyRequest(`${endpoint}/health`)).json()).connected, true);
});
