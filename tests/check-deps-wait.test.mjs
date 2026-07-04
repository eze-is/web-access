import test from 'node:test';
import assert from 'node:assert/strict';

import { waitForProxyConnection } from '../scripts/check-deps-helpers.mjs';

test('waitForProxyConnection polls health until proxy reports connected', async () => {
  const calls = [];
  const healthUrl = 'http://127.0.0.1:3456/health';
  const responses = [
    { status: 'ok', connected: false },
    { status: 'ok', connected: false },
    { status: 'ok', connected: true, browser: { label: 'Chrome' } },
  ];

  const ready = await waitForProxyConnection({
    healthUrl,
    attempts: responses.length,
    httpGetJson: async (url) => {
      calls.push(url);
      return responses.shift() ?? null;
    },
    sleep: async () => {},
  });

  assert.equal(ready, true);
  assert.deepEqual(calls, [healthUrl, healthUrl, healthUrl]);
});

test('waitForProxyConnection returns false after exhausting health polls', async () => {
  const healthUrl = 'http://127.0.0.1:3456/health';

  const ready = await waitForProxyConnection({
    healthUrl,
    attempts: 2,
    httpGetJson: async () => ({ status: 'ok', connected: false }),
    sleep: async () => {},
  });

  assert.equal(ready, false);
});
