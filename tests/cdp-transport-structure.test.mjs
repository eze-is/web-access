import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('CDP mode uses unified cdp-proxy and cdp extension transport names', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'cdp-proxy.mjs')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'check-cdp.mjs')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'cdp-extension-transport.mjs')), true);

  assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'check-webext.mjs')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'webext-proxy.mjs')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'webext-proxy-lib.mjs')), false);
});

test('root extension connects to the unified CDP proxy port', () => {
  const background = fs.readFileSync(path.join(ROOT, 'extension', 'background.js'), 'utf8');
  assert.match(background, /http:\/\/127\.0\.0\.1:3456/);
  assert.match(background, /ws:\/\/127\.0\.0\.1:3456\/ext/);
  assert.doesNotMatch(background, /3457/);
});
