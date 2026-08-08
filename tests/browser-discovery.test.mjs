import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import test from 'node:test';

import {
  checkPort,
  classifyPortError,
  findFallbackPort,
  resolveBrowserSelection,
} from '../scripts/browser-discovery.mjs';

const edge = {
  id: 'edge',
  label: 'Microsoft Edge',
  port: 9222,
  wsPath: '/devtools/browser/test',
};

const skillInstructions = fs.readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');

test('instructs Codex to request an unsandboxed CDP preflight on the first attempt', () => {
  assert.match(
    skillInstructions,
    /Codex[^\n]*首次运行 `check-deps\.mjs` 就必须申请在受限\/沙箱环境外执行/
  );
  assert.match(skillInstructions, /不要先在默认沙箱内试跑/);
});

test('classifies sandbox permission errors separately from unreachable ports', () => {
  assert.equal(classifyPortError('EPERM'), 'restricted');
  assert.equal(classifyPortError('EACCES'), 'restricted');
  assert.equal(classifyPortError('ECONNREFUSED'), 'unreachable');
  assert.equal(classifyPortError('ETIMEDOUT'), 'unreachable');
});

test('checkPort preserves EPERM from the socket probe', async (t) => {
  const socket = new EventEmitter();
  socket.destroy = () => {};
  t.mock.method(net, 'createConnection', () => socket);

  const resultPromise = checkPort(9222, '127.0.0.1', 100);
  queueMicrotask(() => {
    const error = new Error('operation not permitted');
    error.code = 'EPERM';
    socket.emit('error', error);
  });

  assert.deepEqual(await resultPromise, { status: 'restricted', errorCode: 'EPERM' });
});

test('fallback port scanning preserves restricted probes', async (t) => {
  t.mock.method(net, 'createConnection', () => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    queueMicrotask(() => {
      const error = new Error('operation not permitted');
      error.code = 'EPERM';
      socket.emit('error', error);
    });
    return socket;
  });

  const result = await findFallbackPort();
  assert.equal(result.kind, 'restricted');
  assert.deepEqual(result.restricted.map(({ port, errorCode }) => ({ port, errorCode })), [
    { port: 9222, errorCode: 'EPERM' },
    { port: 9229, errorCode: 'EPERM' },
    { port: 9333, errorCode: 'EPERM' },
  ]);
});

test('reports an explicitly selected browser as restricted instead of mismatched', () => {
  const result = resolveBrowserSelection({
    detected: [],
    restricted: [{ ...edge, errorCode: 'EPERM' }],
    configured: null,
    override: 'edge',
  });

  assert.equal(result.kind, 'restricted');
  assert.equal(result.source, 'override');
  assert.equal(result.browser.id, 'edge');
  assert.equal(result.browser.errorCode, 'EPERM');
});

test('reports a configured browser as restricted instead of mismatched', () => {
  const result = resolveBrowserSelection({
    detected: [],
    restricted: [{ ...edge, errorCode: 'EACCES' }],
    configured: 'edge',
    override: null,
  });

  assert.equal(result.kind, 'restricted');
  assert.equal(result.source, 'preference');
  assert.equal(result.browser.id, 'edge');
});

test('reports a restricted environment when no browser preference exists', () => {
  const result = resolveBrowserSelection({
    detected: [],
    restricted: [{ ...edge, errorCode: 'EPERM' }],
    configured: null,
    override: null,
  });

  assert.equal(result.kind, 'restricted');
  assert.equal(result.browser, undefined);
  assert.equal(result.restricted[0].id, 'edge');
});

test('keeps the existing mismatch result for genuinely unreachable browsers', () => {
  const result = resolveBrowserSelection({
    detected: [],
    restricted: [],
    configured: null,
    override: 'edge',
  });

  assert.equal(result.kind, 'mismatch');
});
