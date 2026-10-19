import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = `
import fs from 'node:fs';
import path from 'node:path';
export const root = process.env.TEST_RUNTIME_ROOT;
export function record(action, data = {}) {
  fs.appendFileSync(path.join(root, 'events-' + process.pid + '.jsonl'), JSON.stringify({ action, pid: process.pid, ...data }) + '\\n');
}
export function waitBarrier(name) {
  const file = path.join(root, name + '-release');
  if (fs.existsSync(file)) return Promise.resolve();
  return new Promise(resolve => {
    const watcher = fs.watch(root, () => {
      if (fs.existsSync(file)) { watcher.close(); resolve(); }
    });
    if (fs.existsSync(file)) { watcher.close(); resolve(); }
  });
}
`;
// 提示文案用真实实现；选择结果可由 TEST_SELECT 指定。Proxy 不得再有固定端口兜底：真实模块不导出它，导入即失败。
const DISCOVERY = `
import { record, waitBarrier } from './fake-runtime.mjs';
export * from './browser-discovery-real.mjs';
export async function selectBrowser() {
  record('discovery');
  if (process.env.TEST_HOLD_DISCOVERY === '1') await waitBarrier('discovery');
  if (process.env.TEST_SELECT) return JSON.parse(process.env.TEST_SELECT);
  return { kind: 'ok', browser: { id: '/fake/Google/Chrome', label: 'Chrome', port: 9222, wsPath: '/fake-browser' }, source: 'preference' };
}
`;
const PRELOAD = `
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { root, record, waitBarrier } from './fake-runtime.mjs';
const originalCreateServer = http.createServer;
http.createServer = function (...args) {
  const index = args.findIndex(value => typeof value === 'function');
  if (index !== -1) {
    const listener = args[index];
    args[index] = function (req, res) { record('request', { url: req.url }); return listener.call(this, req, res); };
  }
  return originalCreateServer.apply(this, args);
};
if (process.env.TEST_HOLD_SHUTDOWN === '1') {
  const originalClose = http.Server.prototype.close;
  http.Server.prototype.close = function (callback) {
    record('server-close');
    waitBarrier('shutdown').then(() => originalClose.call(this, callback));
    return this;
  };
}
class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  constructor(url) {
    super();
    this.readyState = 0;
    record('socket', { url });
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
      record('opened');
      if (process.env.TEST_BACKGROUND_PENDING === '1') {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Fetch.requestPaused', params: { requestId: 'fake-request', sessionId: 'fake-session' } }) }));
      }
    });
  }
  send(text) {
    const message = JSON.parse(text);
    const { contextId, targetId, x, y } = message.params || {};
    record('command', { method: message.method, id: message.id, sessionId: message.sessionId, contextId, targetId, x, y });
    void this.respond(message);
  }
  reply(message, payload) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, ...payload }) }));
  }
  // TEST_FRAMES=1：页面 user-page 有同进程 iframe local-frame 与跨进程 iframe oopif-frame（子 session 按 attach 次数编号）
  respondFrames(message) {
    const params = message.params || {};
    switch (message.method) {
      case 'Target.attachToTarget':
        if (params.targetId === 'oopif-frame') return { sessionId: 'frame-session-' + (this.frameAttaches = (this.frameAttaches || 0) + 1) };
        return null;
      case 'Runtime.evaluate':
        if (params.expression.includes('querySelectorAll')) return { result: { objectId: 'node-list' } };
        if (params.expression.includes('elementFromPoint')) {
          // 页面上命中跨进程 iframe，视口外（测试用 x=5000）返回 null；子 frame 里命中普通按钮
          if (params.expression.includes('elementFromPoint(5000')) return { result: { type: 'object', subtype: 'null' } };
          return { result: { objectId: message.sessionId === 'fake-session' ? 'el-oopif' : 'el-button' } };
        }
        if (params.expression.includes('innerWidth')) return { result: { value: [300, 250] } };
        if (params.contextId) return { result: { value: 'frame:' + message.sessionId } };
        return null;
      case 'Runtime.getProperties':
        return { result: [{ name: '0', value: { objectId: 'el-local' } }, { name: '1', value: { objectId: 'el-oopif' } }] };
      case 'DOM.describeNode':
        if (params.objectId === 'el-button') return { node: { attributes: [] } };
        return { node: params.objectId === 'el-local'
          ? { frameId: 'local-frame', attributes: ['name', 'kid'] }
          : { frameId: 'oopif-frame', attributes: ['id', 'pay'] } };
      case 'DOM.getBoxModel':
        return { model: { content: [55, 65, 355, 65, 355, 315, 55, 315] } };
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'user-page' }, childFrames: [{ frame: { id: 'local-frame', url: 'http://localhost/same' } }] } };
      case 'Page.createIsolatedWorld':
        return { executionContextId: 7 };
      case 'Runtime.callFunctionOn':
        return { result: { value: { x: 55, y: 65 } } };
    }
    return null;
  }
  async respond(message) {
    if (message.method === 'Runtime.evaluate' && process.env.TEST_EVAL_RESPONSE) {
      this.reply(message, { result: JSON.parse(process.env.TEST_EVAL_RESPONSE) });
      return;
    }
    // 已被浏览器解除的 session：与真实 Chrome 一样报错
    if (message.sessionId && this.dead?.has(message.sessionId)) {
      this.reply(message, { error: { code: -32001, message: 'Session with given id not found.' } });
      record('response', { method: message.method, error: true });
      return;
    }
    if (process.env.TEST_FRAMES === '1') {
      const result = this.respondFrames(message);
      if (result) {
        this.reply(message, { result });
        record('response', { method: message.method });
        // TEST_DETACH_FRAME=1：第一次在子 session 中执行后，浏览器解除该 session（模拟 iframe 换进程）
        if (process.env.TEST_DETACH_FRAME === '1' && message.method === 'Runtime.evaluate' && message.params.contextId && message.sessionId?.startsWith('frame-session') && !this.dead) {
          this.dead = new Set([message.sessionId]);
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: message.sessionId, targetId: 'oopif-frame' } }) }));
        }
        return;
      }
    }
    if (message.method === 'Target.getTargets' && process.env.TEST_HOLD_TARGETS === '1') await waitBarrier('targets');
    if (message.method === 'Fetch.failRequest' && process.env.TEST_BACKGROUND_PENDING === '1') await waitBarrier('pending');
    let result = {};
    if (message.method === 'Target.getTargets') {
      result = { targetInfos: [{ targetId: 'user-page', type: 'page', title: 'Fake page', url: 'about:blank' }] };
      if (process.env.TEST_FRAMES === '1') result.targetInfos.push({ targetId: 'oopif-frame', type: 'iframe', url: 'http://127.0.0.1/child' });
    }
    if (message.method === 'Target.createTarget') result = { targetId: 'managed-page' };
    if (message.method === 'Target.closeTarget') result = { success: true };
    if (message.method === 'Target.attachToTarget') result = { sessionId: 'fake-session' };
    if (message.method === 'Runtime.evaluate') {
      if (message.params.expression.includes('JSON.stringify({ ready:')) {
        const ready = fs.existsSync(path.join(root, 'page-release')) ? 'complete' : 'loading';
        result = { result: { value: JSON.stringify({ ready, url: 'https://fake.example/page' }) } };
      } else result = { result: { value: 'fake value' } };
    }
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, result }) }));
    record('response', { method: message.method, complete: message.method === 'Runtime.evaluate' && fs.existsSync(path.join(root, 'page-release')) });
  }
  close() {
    this.readyState = 3;
    record('socket-close');
    this.dispatchEvent(new Event('close'));
  }
}
globalThis.WebSocket = FakeWebSocket;
`;

function beginRequest(port, endpoint, { method = 'GET', body, headers = {}, deferBody = false } = {}) {
  const encoded = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  let request;
  const done = new Promise((resolve, reject) => {
    request = http.request({
      hostname: '127.0.0.1', port, path: endpoint, method, agent: false,
      headers: { ...(encoded === undefined ? {} : { 'Content-Length': Buffer.byteLength(encoded), 'Content-Type': 'application/json' }), ...headers },
    }, res => {
      let content = '';
      res.setEncoding('utf8');
      res.on('data', data => { content += data; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(content) }); }
        catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
    request.setTimeout(8000, () => request.destroy(new Error('Test HTTP request timed out')));
    if (deferBody) request.flushHeaders();
    else request.end(encoded);
  });
  return { request, done, finish: () => request.end(encoded) };
}

const requestJson = (port, endpoint, options) => beginRequest(port, endpoint, options).done;

async function fixture(t, flags = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'web-access-proxy-'));
  const scripts = path.join(root, 'scripts');
  await fsp.mkdir(scripts);
  for (const name of ['cdp-proxy.mjs', 'cdp-connection.mjs', 'page-frames.mjs', 'user-data.mjs']) {
    await fsp.copyFile(path.join(SCRIPTS, name), path.join(scripts, name));
  }
  await fsp.writeFile(path.join(scripts, 'fake-runtime.mjs'), RUNTIME);
  await fsp.copyFile(path.join(SCRIPTS, 'browser-discovery.mjs'), path.join(scripts, 'browser-discovery-real.mjs'));
  await fsp.writeFile(path.join(scripts, 'browser-discovery.mjs'), DISCOVERY);
  await fsp.writeFile(path.join(scripts, 'preload.mjs'), PRELOAD);
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const children = [];
  const events = async () => {
    const files = (await fsp.readdir(root)).filter(name => name.endsWith('.jsonl'));
    const lines = await Promise.all(files.map(name => fsp.readFile(path.join(root, name), 'utf8')));
    return lines.flatMap(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line)));
  };
  const waitEvent = predicate => new Promise((resolve, reject) => {
    let finished = false;
    const watcher = fs.watch(root, () => { void inspect(); });
    const timeout = setTimeout(() => finish(new Error('Expected test event did not arrive')), 8000);
    function finish(error, value) {
      if (finished) return;
      finished = true;
      watcher.close();
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    }
    async function inspect() {
      try {
        const value = predicate(await events());
        if (value) finish(null, value);
      } catch (error) { finish(error); }
    }
    void inspect();
  });
  t.after(async () => {
    // 只强制清理本测试创建的子进程；不按名称或端口终止真实服务。
    for (const entry of children) if (entry.child.exitCode === null) entry.child.kill('SIGKILL');
    await Promise.all(children.map(entry => entry.exited));
    await fsp.rm(root, { recursive: true, force: true });
  });
  return {
    port, root, scripts, events, waitEvent,
    release: name => fsp.writeFile(path.join(root, name + '-release'), ''),
    spawn() {
      const child = spawn(process.execPath, ['--import', path.join(scripts, 'preload.mjs'), path.join(scripts, 'cdp-proxy.mjs')], {
        env: { ...process.env, CDP_PROXY_PORT: String(port), TEST_RUNTIME_ROOT: root, ...flags },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal, pid: child.pid }));
      });
      const entry = { child, exited, get output() { return output; } };
      children.push(entry);
      return entry;
    },
    async ready(entry) {
      await waitEvent(list => list.find(event => event.action === 'opened' && event.pid === entry.child.pid));
      return (await requestJson(port, '/health')).body;
    },
  };
}

async function shutdown(f, health) {
  return requestJson(f.port, '/shutdown', { method: 'POST', body: { instanceId: health.instanceId } });
}

for (const [name, evaluation, expected] of [
  ['Promise rejection', {
    // returnByValue serializes the rejected Error as {}, alongside exceptionDetails.
    result: { type: 'object', value: {} },
    exceptionDetails: { text: 'Uncaught (in promise)', exception: { type: 'object', subtype: 'error', description: 'Error: API unavailable\n    at <anonymous>:1:22' } },
  }, { status: 400, body: { error: 'Error: API unavailable\n    at <anonymous>:1:22' } }],
  ...['request failed', 0, false, null, ''].map(value => [`thrown ${JSON.stringify(value)}`, {
    result: { type: value === null ? 'object' : typeof value, value },
    exceptionDetails: { text: 'Uncaught', exception: { type: value === null ? 'object' : typeof value, value } },
  }, { status: 400, body: { error: String(value) } }]),
  ['exception without remote details', {
    result: { type: 'undefined' },
    exceptionDetails: { text: 'Uncaught' },
  }, { status: 400, body: { error: 'Uncaught' } }],
  ...[0, false, null, ''].map(value => [`successful ${JSON.stringify(value)}`, {
    result: { type: value === null ? 'object' : typeof value, value },
  }, { status: 200, body: { value } }]),
]) {
  test(`/eval reports ${name}`, { timeout: 12000 }, async t => {
    const f = await fixture(t, { TEST_EVAL_RESPONSE: JSON.stringify(evaluation) });
    const entry = f.spawn();
    const health = await f.ready(entry);
    const response = await requestJson(f.port, '/eval?target=user-page', { method: 'POST', body: 'testExpression()' });
    assert.deepEqual(response, expected);
    assert.equal((await shutdown(f, health)).status, 202);
    assert.equal((await entry.exited).code, 0);
  });
}

test('真实 HTTP 并行请求在首次发现阶段共享一次发现和一次握手', { timeout: 12000 }, async t => {
  const f = await fixture(t, { TEST_HOLD_DISCOVERY: '1' });
  const entry = f.spawn();
  await f.waitEvent(events => events.find(event => event.action === 'discovery'));
  const initial = (await requestJson(f.port, '/health')).body;
  assert.equal(initial.connectionState, 'discovering');
  assert.equal(initial.connectionAttempts, 1);
  assert.equal(initial.connected, false);
  assert.equal(initial.activeRequests, 0);
  assert.equal(initial.pendingCommands, 0);
  assert.equal((await shutdown(f, initial)).status, 409, '只有发现过程进行中也不能维护');
  const requests = Promise.all([requestJson(f.port, '/targets'), requestJson(f.port, '/targets')]);
  await f.waitEvent(events => events.filter(event => event.action === 'request' && event.url === '/targets').length === 2);
  assert.equal((await requestJson(f.port, '/health')).body.activeRequests, 2);
  await f.release('discovery');
  for (const response of await requests) {
    assert.equal(response.status, 200);
    assert.equal(response.body[0].targetId, 'user-page');
  }
  const events = await f.events();
  assert.equal(events.filter(event => event.action === 'discovery').length, 1);
  assert.equal(events.filter(event => event.action === 'socket').length, 1);
  assert.equal(events.filter(event => event.action === 'command' && event.method === 'Target.getTargets').length, 2);
  const health = await f.ready(entry);
  assert.equal(health.connectionAttempts, 1);
  assert.equal(health.activeRequests, 0);
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await entry.exited).code, 0);
});

test('两个子进程原子争抢同一端口，只有赢家发现和连接浏览器', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const first = f.spawn();
  const second = f.spawn();
  const loser = await Promise.race([first.exited, second.exited]);
  assert.equal(loser.code, 0);
  const winner = loser.pid === first.child.pid ? second : first;
  const health = await f.ready(winner);
  assert.equal(health.pid, winner.child.pid);
  const events = await f.events();
  assert.equal(events.filter(event => event.action === 'discovery').length, 1);
  assert.equal(events.filter(event => event.action === 'socket').length, 1);
  assert.equal(events.filter(event => event.pid === loser.pid && ['discovery', 'socket'].includes(event.action)).length, 0);
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await winner.exited).code, 0);
});

test('/health 提供稳定实例、运行版本与连接和占用状态', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const entry = f.spawn();
  const health = await f.ready(entry);
  const revision = createHash('sha256')
    .update(await fsp.readFile(path.join(f.scripts, 'cdp-proxy.mjs')))
    .update(await fsp.readFile(path.join(f.scripts, 'cdp-connection.mjs')))
    .digest('hex').slice(0, 12);
  assert.match(health.instanceId, /^[0-9a-f-]{36}$/);
  assert.equal(health.runningRevision, revision);
  assert.ok(Number.isFinite(Date.parse(health.startedAt)));
  assert.equal(health.pid, entry.child.pid);
  assert.equal(health.connectionState, 'connected');
  assert.equal(health.connectionAttempts, 1);
  assert.equal(health.pendingCommands, 0);
  assert.equal(health.activeRequests, 0);
  assert.equal(health.maintenance, false);
  assert.equal((await requestJson(f.port, '/health')).body.instanceId, health.instanceId);
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await entry.exited).code, 0);
});

test('/shutdown 拒绝 GET、Origin、非法 JSON 与不匹配实例，空闲后接受并退出', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const entry = f.spawn();
  const health = await f.ready(entry);
  assert.equal((await requestJson(f.port, '/shutdown')).status, 403);
  assert.equal((await requestJson(f.port, '/shutdown', { method: 'POST', headers: { Origin: 'https://example.com' }, body: { instanceId: health.instanceId } })).status, 403);
  assert.equal((await requestJson(f.port, '/shutdown', { method: 'POST', body: '{broken' })).status, 400);
  for (const body of [null, { instanceId: 'wrong-instance' }]) {
    const response = await requestJson(f.port, '/shutdown', { method: 'POST', body });
    assert.equal(response.status, 409);
    assert.equal(response.body.instanceId, health.instanceId);
  }
  assert.equal((await requestJson(f.port, '/health')).body.maintenance, false);
  const response = await shutdown(f, health);
  assert.equal(response.status, 202);
  assert.equal(response.body.status, 'stopping');
  assert.equal((await entry.exited).code, 0);
});

test('/shutdown 在 HTTP 请求和 CDP 命令都等待时拒绝关闭', { timeout: 12000 }, async t => {
  const f = await fixture(t, { TEST_HOLD_TARGETS: '1' });
  const entry = f.spawn();
  const health = await f.ready(entry);
  const targets = requestJson(f.port, '/targets');
  await f.waitEvent(events => events.find(event => event.action === 'command' && event.method === 'Target.getTargets'));
  const busy = await shutdown(f, health);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.activeRequests, 1);
  assert.equal(busy.body.pendingCommands, 1);
  await f.release('targets');
  assert.equal((await targets).status, 200);
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await entry.exited).code, 0);
});

test('/shutdown 单独存在 HTTP handler 时也拒绝关闭', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const entry = f.spawn();
  const health = await f.ready(entry);
  const active = beginRequest(f.port, '/eval?target=user-page', { method: 'POST', body: 'document.title', deferBody: true });
  await f.waitEvent(events => events.find(event => event.action === 'response' && event.method === 'Fetch.enable'));
  const busy = await shutdown(f, health);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.activeRequests, 1);
  assert.equal(busy.body.pendingCommands, 0);
  active.finish();
  assert.equal((await active.done).status, 200);
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await entry.exited).code, 0);
});

test('/shutdown 单独存在后台 CDP 命令时也拒绝关闭', { timeout: 12000 }, async t => {
  const f = await fixture(t, { TEST_BACKGROUND_PENDING: '1' });
  const entry = f.spawn();
  const health = await f.ready(entry);
  await f.waitEvent(events => events.find(event => event.action === 'command' && event.method === 'Fetch.failRequest'));
  const busy = await shutdown(f, health);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.activeRequests, 0);
  assert.equal(busy.body.pendingCommands, 1);
  await f.release('pending');
  await f.waitEvent(events => events.find(event => event.action === 'response' && event.method === 'Fetch.failRequest'));
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await entry.exited).code, 0);
});

test('/shutdown 单独存在受管标签页时拒绝关闭，关闭标签页后才可维护', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const entry = f.spawn();
  const health = await f.ready(entry);
  const created = await requestJson(f.port, '/new', { method: 'POST', body: 'about:blank' });
  assert.equal(created.status, 200);
  assert.equal(created.body.targetId, 'managed-page');
  const occupied = (await requestJson(f.port, '/health')).body;
  assert.equal(occupied.managedTabs, 1);
  assert.equal(occupied.activeRequests, 0);
  assert.equal(occupied.pendingCommands, 0);
  const busy = await shutdown(f, health);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.managedTabs, 1);
  assert.equal(busy.body.activeRequests, 0);
  assert.equal(busy.body.pendingCommands, 0);
  assert.equal((await requestJson(f.port, '/close?target=managed-page')).status, 200);
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await entry.exited).code, 0);
});

test('客户端断开后仍在运行的导航 handler 持续占用，完成后才可维护', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const entry = f.spawn();
  const health = await f.ready(entry);
  const navigation = beginRequest(f.port, '/navigate?target=user-page', { method: 'POST', body: 'https://fake.example/page' });
  const aborted = navigation.done.catch(error => error);
  await f.waitEvent(events => events.find(event => event.action === 'response' && event.method === 'Page.enable'));
  navigation.request.destroy();
  assert.ok(await aborted instanceof Error);
  const occupied = (await requestJson(f.port, '/health')).body;
  assert.equal(occupied.managedTabs, 0);
  assert.equal(occupied.pendingCommands, 0);
  assert.equal(occupied.activeRequests, 1);
  const busy = await shutdown(f, health);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.activeRequests, 1);
  await f.release('page');
  await f.waitEvent(events => events.find(event => event.action === 'response' && event.method === 'Runtime.evaluate' && event.complete));
  assert.equal((await requestJson(f.port, '/health')).body.activeRequests, 0);
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await entry.exited).code, 0);
});

test('维护过程中普通 API 返回 503，释放退出屏障后正常退出', { timeout: 12000 }, async t => {
  const f = await fixture(t, { TEST_HOLD_SHUTDOWN: '1' });
  const entry = f.spawn();
  const health = await f.ready(entry);
  assert.equal((await shutdown(f, health)).status, 202);
  await f.waitEvent(events => events.find(event => event.action === 'server-close'));
  assert.equal((await requestJson(f.port, '/health')).body.maintenance, true);
  const response = await requestJson(f.port, '/targets');
  assert.equal(response.status, 503);
  assert.match(response.body.error, /维护/);
  assert.equal((await f.events()).filter(event => event.action === 'command').length, 0);
  await f.release('shutdown');
  assert.equal((await entry.exited).code, 0);
});

for (const { name, select, pattern } of [
  { name: '未设置浏览器', select: { kind: 'unset' }, pattern: /尚未设置浏览器.*check-deps/ },
  {
    name: '所选浏览器不可用',
    select: { kind: 'unavailable', source: 'preference', reason: 'not-enabled', browser: { id: '/fake/Dia/User Data', label: 'Dia' } },
    pattern: /默认偏好的浏览器 Dia.*chrome:\/\/inspect\/#remote-debugging.*edge:\/\/inspect\/#remote-debugging/,
  },
]) {
  test(`${name}时请求硬错，不建立 socket、不扫描其他端口`, { timeout: 12000 }, async t => {
    const f = await fixture(t, { TEST_SELECT: JSON.stringify(select) });
    const entry = f.spawn();
    await f.waitEvent(events => events.find(event => event.action === 'discovery' && event.pid === entry.child.pid));
    const response = await requestJson(f.port, '/targets');
    assert.equal(response.status, 500);
    assert.match(response.body.error, pattern);
    const health = (await requestJson(f.port, '/health')).body;
    assert.equal(health.connected, false);
    assert.equal(health.browser, null);
    assert.equal((await f.events()).filter(event => event.action === 'socket').length, 0);
    assert.equal((await shutdown(f, health)).status, 202);
    assert.equal((await entry.exited).code, 0);
  });
}

const commandsOf = (events, method) => events.filter(event => event.action === 'command' && event.method === method);

test('/frames 列出 iframe；/eval?frame= 在跨进程 iframe 的子 session 中执行，不带 frame 的 /eval 参数不变', { timeout: 12000 }, async t => {
  const f = await fixture(t, { TEST_FRAMES: '1' });
  const entry = f.spawn();
  await f.ready(entry);
  const frames = await requestJson(f.port, '/frames?target=user-page');
  assert.equal(frames.status, 200);
  assert.deepEqual(frames.body.map(frame => [frame.frameId, frame.crossProcess, frame.url]), [
    ['local-frame', false, 'http://localhost/same'],
    ['oopif-frame', true, 'http://127.0.0.1/child'],
  ]);
  const inFrame = await requestJson(f.port, '/eval?target=user-page&frame=oopif-frame', { method: 'POST', body: 'document.title' });
  assert.deepEqual(inFrame.body, { value: 'frame:frame-session-1' });
  const plain = await requestJson(f.port, '/eval?target=user-page', { method: 'POST', body: 'document.title' });
  assert.deepEqual(plain.body, { value: 'fake value' });
  const evaluations = commandsOf(await f.events(), 'Runtime.evaluate').filter(event => !event.contextId && event.sessionId === 'fake-session');
  assert.ok(evaluations.length >= 1);
  const health = (await requestJson(f.port, '/health')).body;
  assert.equal(health.managedTabs, 0);
  assert.equal(health.activeRequests, 0);
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await entry.exited).code, 0);
});

test('/eval?frame= 只接受本页面 iframe 的 frameId，其他目标或格式错误返回 400 且不 attach', { timeout: 12000 }, async t => {
  const f = await fixture(t, { TEST_FRAMES: '1' });
  const entry = f.spawn();
  const health = await f.ready(entry);
  for (const frame of ['user-page', 'other-page', '%23pay', '']) {
    const response = await requestJson(f.port, `/eval?target=user-page&frame=${frame}`, { method: 'POST', body: '1' });
    assert.equal(response.status, 400, frame);
    assert.match(response.body.error, /frame/);
  }
  const attached = commandsOf(await f.events(), 'Target.attachToTarget').map(event => event.targetId);
  assert.ok(attached.every(id => id === 'user-page'), attached.join(','));
  // 列举只在页面根 frame 的隔离环境中进行，没有进入任何 iframe
  assert.ok(commandsOf(await f.events(), 'Page.createIsolatedWorld').every(event => event.sessionId === 'fake-session'));
  assert.equal((await requestJson(f.port, '/frames')).status, 400);
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await entry.exited).code, 0);
});

test('/clickXY 校验参数；命中跨进程 iframe 时鼠标事件扣除偏移后发给子 session', { timeout: 12000 }, async t => {
  const f = await fixture(t, { TEST_FRAMES: '1' });
  const entry = f.spawn();
  const health = await f.ready(entry);
  for (const query of ['x=1&y=1', 'target=user-page&y=1', 'target=user-page&x=-1&y=1', 'target=user-page&x=abc&y=1', 'target=user-page&x=Infinity&y=1', 'target=user-page&x=%20&y=1']) {
    const response = await requestJson(f.port, `/clickXY?${query}`);
    assert.equal(response.status, 400, query);
    assert.match(response.body.error, /x、y/);
  }
  assert.equal(commandsOf(await f.events(), 'Input.dispatchMouseEvent').length, 0);
  const outside = await requestJson(f.port, '/clickXY?target=user-page&x=5000&y=5000');
  assert.equal(outside.status, 400);
  assert.match(outside.body.error, /不在页面视口内/);
  assert.equal(commandsOf(await f.events(), 'Input.dispatchMouseEvent').length, 0);
  const response = await requestJson(f.port, '/clickXY?target=user-page&x=115&y=95');
  assert.deepEqual(response.body, { clicked: true, x: 115, y: 95, frameId: 'oopif-frame', crossProcess: true, depth: 1 });
  const mouse = commandsOf(await f.events(), 'Input.dispatchMouseEvent');
  assert.equal(mouse.length, 3);
  assert.ok(mouse.every(event => event.sessionId === 'frame-session-1' && event.x === 60 && event.y === 30), JSON.stringify(mouse));
  assert.equal(commandsOf(await f.events(), 'Target.activateTarget').length, 0);
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await entry.exited).code, 0);
});

test('浏览器解除子 session 后从缓存删除，下一次重新 attach，不复用失效的 session', { timeout: 12000 }, async t => {
  const f = await fixture(t, { TEST_FRAMES: '1', TEST_DETACH_FRAME: '1' });
  const entry = f.spawn();
  const health = await f.ready(entry);
  const first = await requestJson(f.port, '/eval?target=user-page&frame=oopif-frame', { method: 'POST', body: '1' });
  assert.deepEqual(first.body, { value: 'frame:frame-session-1' });
  const second = await requestJson(f.port, '/eval?target=user-page&frame=oopif-frame', { method: 'POST', body: '1' });
  assert.deepEqual(second.body, { value: 'frame:frame-session-2' });
  assert.equal(commandsOf(await f.events(), 'Target.attachToTarget').filter(event => event.targetId === 'oopif-frame').length, 2);
  assert.equal((await shutdown(f, health)).status, 202);
  assert.equal((await entry.exited).code, 0);
});
