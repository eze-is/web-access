import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

import {
  ExtensionBridge,
  createHttpHandler,
  encodeTextFrame,
  handleWebSocketUpgrade,
  WebSocketFrameReader,
} from '../scripts/cdp-extension-transport.mjs';

test('websocket frame codec round-trips masked client text frames', () => {
  const reader = new WebSocketFrameReader();
  const payload = JSON.stringify({ type: 'hello', version: 'test' });
  const frames = reader.push(encodeTextFrame(payload, { masked: true }));

  assert.deepEqual(frames, [payload]);
});

test('bridge forwards commands to the connected extension and resolves matching responses', async () => {
  const bridge = new ExtensionBridge({ commandTimeoutMs: 500 });
  const sent = [];
  bridge.attach({
    label: 'fake-extension',
    send: (payload) => sent.push(JSON.parse(payload)),
    close: () => {},
  });

  const pending = bridge.command('eval', { target: 'target-1', code: 'document.title' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'eval');
  assert.equal(sent[0].target, 'target-1');

  bridge.receive(JSON.stringify({ id: sent[0].id, ok: true, value: 'Example' }));

  assert.deepEqual(await pending, { id: sent[0].id, ok: true, value: 'Example' });
});

test('HTTP /new sends the raw POST body URL without query-string truncation', async () => {
  const bridge = new ExtensionBridge({ commandTimeoutMs: 500 });
  const sent = [];
  bridge.attach({
    label: 'fake-extension',
    send: (payload) => {
      const message = JSON.parse(payload);
      sent.push(message);
      bridge.receive(JSON.stringify({ id: message.id, ok: true, targetId: 'target-new' }));
    },
    close: () => {},
  });

  const server = http.createServer(createHttpHandler({ bridge }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const url = 'https://example.test/path?a=1&b=2#frag';

  const response = await fetch(`http://127.0.0.1:${port}/new`, {
    method: 'POST',
    body: url,
  });

  try {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { targetId: 'target-new' });
    assert.equal(sent[0].action, 'new');
    assert.equal(sent[0].url, url);
  } finally {
    server.close();
  }
});

test('HTTP /health reports extension connection state', async () => {
  const bridge = new ExtensionBridge({ commandTimeoutMs: 500 });
  const server = http.createServer(createHttpHandler({ bridge }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const before = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    assert.equal(before.connected, false);

    bridge.attach({ label: 'fake-extension', send: () => {}, close: () => {} });
    bridge.receive(JSON.stringify({ type: 'hello', version: '1.0.0', browser: 'Chrome' }));

    const after = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    assert.equal(after.connected, true);
    assert.equal(after.extension.version, '1.0.0');
    assert.equal(after.extension.browser, 'Chrome');
  } finally {
    server.close();
  }
});

test('HTTP rejects browser page origins but allows extension origins', async () => {
  const bridge = new ExtensionBridge({ commandTimeoutMs: 500 });
  const server = http.createServer(createHttpHandler({ bridge }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const forbidden = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: 'https://example.test' },
    });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await forbidden.json(), { error: 'forbidden_origin' });

    const allowed = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: 'chrome-extension://abcdefghijklmnop' },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'chrome-extension://abcdefghijklmnop');
    assert.equal((await allowed.json()).status, 'ok');
  } finally {
    server.close();
  }
});

test('websocket bridge rejects non-extension origins', () => {
  const bridge = new ExtensionBridge({ commandTimeoutMs: 500 });
  const writes = [];
  const socket = {
    write: (data) => writes.push(String(data)),
    destroy: () => { socket.destroyed = true; },
    on: () => {},
    destroyed: false,
  };

  handleWebSocketUpgrade({
    url: '/ext',
    headers: {
      origin: 'https://example.test',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    },
  }, socket, Buffer.alloc(0), bridge);

  assert.equal(socket.destroyed, true);
  assert.match(writes.join(''), /403 Forbidden/);
  assert.equal(bridge.isConnected(), false);
});
