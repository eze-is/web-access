import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveProxyEndpoint, isLocalAddress } from './proxy-endpoint.mjs';

test('默认只监听回环地址 127.0.0.1:3456', () => {
  assert.deepEqual(resolveProxyEndpoint({}, {}), {
    host: '127.0.0.1',
    port: 3456,
    localHost: '127.0.0.1',
    authority: '127.0.0.1',
  });
});

test('显式配置读取 config.env，环境变量优先', () => {
  assert.deepEqual(resolveProxyEndpoint({ CDP_PROXY_HOST: '0.0.0.0', CDP_PROXY_PORT: '4567' }, {}), {
    host: '0.0.0.0',
    port: 4567,
    localHost: '127.0.0.1',
    authority: '127.0.0.1',
  });
  assert.equal(resolveProxyEndpoint({ CDP_PROXY_PORT: '4567' }, { CDP_PROXY_PORT: '4568' }).port, 4568);
});

test('IPv6 wildcard 和方括号地址归一化', () => {
  assert.deepEqual(resolveProxyEndpoint({ CDP_PROXY_HOST: '::' }, {}), {
    host: '::',
    port: 3456,
    localHost: '::1',
    authority: '[::1]',
  });
  assert.deepEqual(resolveProxyEndpoint({ CDP_PROXY_HOST: '[::1]' }, {}), {
    host: '::1',
    port: 3456,
    localHost: '::1',
    authority: '[::1]',
  });
});

for (const port of ['0', '65536', 'abc', '', '12abc']) {
  test(`非法端口 ${JSON.stringify(port)} 快速失败`, () => {
    assert.throws(() => resolveProxyEndpoint({ CDP_PROXY_PORT: port }, {}), /1 到 65535/);
  });
}

for (const host of ['', 'http://127.0.0.1', '127.0.0.1/path', 'bad host']) {
  test(`非法 host ${JSON.stringify(host)} 快速失败`, () => {
    assert.throws(() => resolveProxyEndpoint({ CDP_PROXY_HOST: host }, {}), /CDP_PROXY_HOST/);
  });
}

test('本机地址判断覆盖回环、网卡地址与 IPv4-mapped 地址', () => {
  const interfaces = {
    lo0: [{ address: '127.0.0.1' }, { address: '::1' }],
    en0: [{ address: '192.168.1.10' }],
  };
  assert.equal(isLocalAddress('127.0.0.1', interfaces), true);
  assert.equal(isLocalAddress('::1', interfaces), true);
  assert.equal(isLocalAddress('192.168.1.10', interfaces), true);
  assert.equal(isLocalAddress('::ffff:192.168.1.10', interfaces), true);
  assert.equal(isLocalAddress('192.168.1.50', interfaces), false);
  assert.equal(isLocalAddress(null, interfaces), false);
});
