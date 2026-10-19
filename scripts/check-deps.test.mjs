import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

// 旧配置值在当前宿主平台的标准数据目录（与 browser-discovery 的兼容映射一致，用于断言路径身份）
function legacyDataDir(f, alias) {
  const relative = {
    darwin: { chrome: ['Library', 'Application Support', 'Google', 'Chrome'], edge: ['Library', 'Application Support', 'Microsoft Edge'] },
    linux: { chrome: ['.config', 'google-chrome'], edge: ['.config', 'microsoft-edge'] },
    win32: { chrome: ['Google', 'Chrome', 'User Data'], edge: ['Microsoft', 'Edge', 'User Data'] },
  }[process.platform][alias];
  return path.join(process.platform === 'win32' ? f.localAppData : f.home, ...relative);
}

// 当前宿主平台的应用数据根目录（首次配置时 check-deps 列出其最外层文件夹）
function appDataRoot(f) {
  if (process.platform === 'win32') return f.localAppData;
  return process.platform === 'darwin' ? path.join(f.home, 'Library', 'Application Support') : path.join(f.home, '.config');
}

// 所有检查在脚本副本、临时 HOME、临时配置和本地假服务上运行，不接触真实浏览器与真实用户数据。
async function fixture(t, { configured = null, dataDirs = true } = {}) {
  // 取真实路径：浏览器身份按真实路径规范化（macOS 的临时目录经 /var → /private/var 软链接）
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'web-access-check-deps-')));
  const skill = path.join(root, 'skill');
  const home = path.join(root, 'home');
  const scripts = path.join(skill, 'scripts');
  const temporary = path.join(root, 'tmp');
  const eventsPath = path.join(root, 'events.jsonl');
  const configPath = path.join(home, '.web-access', 'config.env');
  const localAppData = path.join(root, 'AppData', 'Local');
  const appData = path.join(root, 'AppData', 'Roaming');
  await fs.mkdir(localAppData, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  await fs.mkdir(scripts, { recursive: true });
  await fs.mkdir(temporary);
  await fs.mkdir(path.join(skill, 'templates'));
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.copyFile(path.join(SCRIPTS, 'check-deps.mjs'), path.join(scripts, 'check-deps.mjs'));
  await fs.copyFile(path.join(SCRIPTS, 'user-data.mjs'), path.join(scripts, 'user-data.mjs'));
  await fs.copyFile(path.join(SCRIPTS, 'browser-probe.mjs'), path.join(scripts, 'browser-probe.mjs'));
  await fs.copyFile(path.join(SCRIPTS, 'browser-discovery.mjs'), path.join(scripts, 'browser-discovery-real.mjs'));
  await fs.writeFile(configPath, configured ? `WEB_ACCESS_BROWSER=${configured}\n` : '');
  // 测试用到的浏览器数据目录（含 Local State），配置值才是有效的
  if (dataDirs) {
    const f = { home, localAppData };
    for (const dir of [legacyDataDir(f, 'chrome'), legacyDataDir(f, 'edge'), path.join(home, 'Dia', 'User Data')]) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'Local State'), '{}');
    }
  }

  // 身份解析、偏好读取与提示文案用真实实现；只替换选择结果（可由 TEST_SELECT 指定），并记录调用。
  await fs.writeFile(path.join(scripts, 'browser-discovery.mjs'), `
import fs from 'node:fs';
import { getConfiguredBrowser, resolveBrowser } from './browser-discovery-real.mjs';
export * from './browser-discovery-real.mjs';
const record = event => fs.appendFileSync(process.env.TEST_EVENTS_PATH, JSON.stringify(event) + '\\n');
export async function selectBrowser(override) {
  record({ action: 'selectBrowser', override });
  if (process.env.TEST_SELECT) return JSON.parse(process.env.TEST_SELECT);
  const raw = override || getConfiguredBrowser();
  if (!raw) return { kind: 'unset' };
  return { kind: 'ok', browser: { ...resolveBrowser(raw), port: 9222 }, source: override ? 'override' : 'preference' };
}
`);
  // 假 Proxy 与真实实现一样报告规范化后的数据目录作为浏览器身份。
  await fs.writeFile(path.join(scripts, 'cdp-proxy.mjs'), `
import fs from 'node:fs';
import http from 'node:http';
import { getConfiguredBrowser, resolveBrowser } from './browser-discovery-real.mjs';
fs.appendFileSync(process.env.TEST_EVENTS_PATH, JSON.stringify({ action: 'spawn', pid: process.pid, args: process.argv.slice(2) }) + '\\n');
const i = process.argv.indexOf('--browser');
const browser = resolveBrowser(i === -1 ? getConfiguredBrowser() : process.argv[i + 1]);
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url === '/health' ? { status: 'ok', connected: true, browser } : []));
}).listen(Number(process.env.CDP_PROXY_PORT), '127.0.0.1');
`);
  // 缩短脚本的轮询间隔，保留实际 HTTP 交互与成功/超时分支。
  const preload = path.join(root, 'fast-timers.mjs');
  await fs.writeFile(preload, `
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, Math.min(delay, 25), ...args);
`);

  const events = async () => {
    try {
      return (await fs.readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  t.after(async () => {
    // 只清理本测试记录的假 Proxy，不终止任何真实服务。
    for (const event of await events()) {
      if (event.action === 'spawn') {
        try { process.kill(event.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    skill,
    home,
    localAppData,
    configPath,
    events,
    async run(port, args = [], extraEnv = {}) {
      const child = spawn(process.execPath, ['--import', preload, path.join(scripts, 'check-deps.mjs'), ...args], {
        env: {
          ...process.env,
          CDP_PROXY_PORT: String(port),
          HOME: home,
          USERPROFILE: home,
          LOCALAPPDATA: localAppData,
          APPDATA: appData,
          TEST_EVENTS_PATH: eventsPath,
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
          ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 10000);
      try {
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        return { code, stdout, stderr };
      } finally {
        clearTimeout(watchdog);
      }
    },
  };
}

async function fakeProxy(t, { browser = 'chrome', connected = true, recover = false, recoverBrowser = null, targetsWhileDisconnected = false, maintenance = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      res.end(JSON.stringify({ status: 'ok', connected, maintenance, browser: { id: browser, label: browser } }));
    } else if (req.url === '/targets') {
      if (recover) connected = true;
      if (recoverBrowser) browser = recoverBrowser;
      res.end(JSON.stringify(connected || targetsWhileDisconnected ? [] : { error: 'not connected' }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { port: server.address().port, requests };
}

function success(result) {
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /proxy: ready/);
}

test('已连接的服务直接复用，无偏好也不扫描或重新启动', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t);
  success(await f.run(proxy.port));
  assert.deepEqual(await f.events(), []);
  assert.ok(proxy.requests.length > 0);
  assert.ok(proxy.requests.every(request => request === '/health'));
});

test('复用时读取 config.env，匹配的偏好无需浏览器发现', async t => {
  const f = await fixture(t, { configured: 'edge' });
  const proxy = await fakeProxy(t, { browser: 'edge' });
  success(await f.run(proxy.port));
  assert.deepEqual(await f.events(), []);
});

for (const connected of [true, false]) {
  test(`维护中的实例不会被当作就绪或另行启动（connected=${connected}）`, async t => {
    const f = await fixture(t);
    const proxy = await fakeProxy(t, { connected, maintenance: true });
    const result = await f.run(proxy.port);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /正在维护/);
    assert.deepEqual(await f.events(), []);
    assert.ok(proxy.requests.every(request => request === '/health'));
  });
}

test('--browser 覆盖 config.env，并且不会改写持久偏好', async t => {
  const f = await fixture(t, { configured: 'edge' });
  const proxy = await fakeProxy(t);
  success(await f.run(proxy.port, ['--browser', 'chrome']));
  assert.deepEqual(await f.events(), []);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), 'WEB_ACCESS_BROWSER=edge\n');
});

for (const { name, configured, args } of [
  { name: 'CLI 指定', configured: 'chrome', args: ['--browser=edge'] },
  { name: 'config.env 偏好', configured: 'edge', args: [] },
]) {
  test(`已有服务与${name}不一致时明确失败，保留原服务`, async t => {
    const f = await fixture(t, { configured });
    const proxy = await fakeProxy(t);
    const result = await f.run(proxy.port, args);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /浏览器不一致/);
    assert.deepEqual(await f.events(), []);
    assert.equal((await (await fetch(`http://127.0.0.1:${proxy.port}/health`)).json()).connected, true);
    assert.ok(proxy.requests.every(request => request === '/health'));
  });
}

for (const { name, configured, args } of [
  { name: 'CLI 指定 Chrome', configured: null, args: ['--browser', 'chrome'] },
  { name: 'config.env 偏好', configured: 'chrome', args: [] },
]) {
  test(`已连接实例身份未知时不能满足 ${name}，失败并保留服务`, async t => {
    const f = await fixture(t, { configured });
    const proxy = await fakeProxy(t, { browser: 'unknown' });
    const result = await f.run(proxy.port, args);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /无法确认当前连接的浏览器/);
    assert.deepEqual(await f.events(), []);
    assert.equal((await (await fetch(`http://127.0.0.1:${proxy.port}/health`)).json()).connected, true);
    assert.ok(proxy.requests.every(request => request === '/health'));
  });
}

test('没有浏览器期望时可复用身份未知的手动调试实例', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t, { browser: 'unknown' });
  success(await f.run(proxy.port));
  assert.deepEqual(await f.events(), []);
  assert.ok(proxy.requests.every(request => request === '/health'));
});

test('已有服务断开时由原服务 /targets 恢复连接，不启动新进程', async t => {
  const f = await fixture(t, { configured: 'chrome' });
  const proxy = await fakeProxy(t, { connected: false, recover: true });
  success(await f.run(proxy.port));
  assert.deepEqual(await f.events(), []);
  assert.ok(proxy.requests.includes('/targets'));
  assert.equal((await (await fetch(`http://127.0.0.1:${proxy.port}/health`)).json()).connected, true);
});

test('断开且身份未知的原实例恢复为配置的 Chrome 后可以继续', async t => {
  const f = await fixture(t, { configured: 'chrome' });
  const proxy = await fakeProxy(t, { browser: 'unknown', connected: false, recover: true, recoverBrowser: 'chrome' });
  success(await f.run(proxy.port));
  assert.deepEqual(await f.events(), []);
  assert.ok(proxy.requests.includes('/targets'));
  const health = await (await fetch(`http://127.0.0.1:${proxy.port}/health`)).json();
  assert.equal(health.connected, true);
  assert.equal(health.browser.id, 'chrome');
});

test('恢复后仍检查浏览器身份，不把其他浏览器当作成功', async t => {
  const f = await fixture(t, { configured: 'edge' });
  const proxy = await fakeProxy(t, { browser: 'unknown', connected: false, recover: true, recoverBrowser: 'chrome' });
  // 初次身份未知不能提前判断；恢复时服务报告真实的浏览器身份。
  const result = await f.run(proxy.port);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /浏览器不一致/);
  assert.deepEqual(await f.events(), []);
});

test('等待恢复超时只报告失败，不停止或替换仍运行的服务', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t, { connected: false });
  const result = await f.run(proxy.port);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /连接超时/);
  assert.deepEqual(await f.events(), []);
  assert.ok(proxy.requests.includes('/targets'));
  assert.equal((await (await fetch(`http://127.0.0.1:${proxy.port}/health`)).json()).status, 'ok');
});

test('/targets 返回空列表也必须等待 health 确认已连接', async t => {
  const f = await fixture(t);
  const proxy = await fakeProxy(t, { connected: false, targetsWhileDisconnected: true });
  const result = await f.run(proxy.port);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /连接超时/);
  assert.deepEqual(await f.events(), []);
  assert.equal((await (await fetch(`http://127.0.0.1:${proxy.port}/health`)).json()).connected, false);
});

test('没有服务时才发现浏览器并启动可在检查结束后继续运行的 Proxy', async t => {
  const f = await fixture(t, { configured: 'chrome' });
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  success(await f.run(port, ['--browser', 'edge']));
  const events = await f.events();
  assert.equal(events.filter(event => event.action === 'selectBrowser').length, 1);
  assert.equal(events.filter(event => event.action === 'spawn').length, 1);
  assert.deepEqual(events.find(event => event.action === 'spawn').args, ['--browser', 'edge']);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.connected, true);
  assert.equal(health.browser.id, legacyDataDir(f, 'edge'));
});

test('旧版本 Skill 目录内的偏好与站点经验在启动早期迁到 HOME/.web-access 并生效', async t => {
  const f = await fixture(t);
  await fs.rm(f.configPath);
  const legacyPatterns = path.join(f.skill, 'references', 'site-patterns');
  await fs.mkdir(path.join(legacyPatterns, 'archive'), { recursive: true });
  await fs.writeFile(path.join(f.skill, 'config.env'), 'WEB_ACCESS_BROWSER=edge\n');
  await fs.writeFile(path.join(legacyPatterns, 'example.com.md'), '---\ndomain: example.com\n---\n');
  await fs.writeFile(path.join(legacyPatterns, 'archive', 'old.com.md'), 'old');
  const proxy = await fakeProxy(t, { browser: 'chrome' });
  // 迁来的 edge 偏好必须被读取：与运行中的 Chrome 实例不一致而失败
  const result = await f.run(proxy.port);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /浏览器不一致/);
  const notice = result.stdout.split('\n').filter(line => line.startsWith('user-data:'));
  assert.equal(notice.length, 1);
  assert.ok(notice[0].includes('config.env') && notice[0].includes('2 个站点经验文件'), notice[0]);
  assert.ok(notice[0].includes(f.skill) && notice[0].includes(path.join(f.home, '.web-access')), notice[0]);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), 'WEB_ACCESS_BROWSER=edge\n');
  assert.equal(await fs.readFile(path.join(f.home, '.web-access', 'site-patterns', 'archive', 'old.com.md'), 'utf8'), 'old');
  assert.equal(await fs.readFile(path.join(f.skill, 'config.env'), 'utf8'), 'WEB_ACCESS_BROWSER=edge\n');

  // 第二次运行不再迁移；站点经验列表附带新目录
  const edgeProxy = await fakeProxy(t, { browser: 'edge' });
  const second = await f.run(edgeProxy.port);
  success(second);
  assert.doesNotMatch(second.stdout, /user-data:/);
  assert.match(second.stdout, /site-patterns: example\.com/);
  assert.ok(second.stdout.includes(path.join(f.home, '.web-access', 'site-patterns')), second.stdout);
});

test('没有旧数据时迁移静默，首次运行在新建的数据目录中从模板创建 config.env', async t => {
  const f = await fixture(t);
  await fs.rm(path.dirname(f.configPath), { recursive: true });
  await fs.copyFile(path.join(SCRIPTS, '..', 'templates', 'config.env.template'), path.join(f.skill, 'templates', 'config.env.template'));
  const proxy = await fakeProxy(t);
  const result = await f.run(proxy.port);
  success(result);
  assert.doesNotMatch(result.stdout, /user-data:/);
  assert.match(result.stdout, /site-patterns: （暂无）/);
  assert.match(await fs.readFile(f.configPath, 'utf8'), /^WEB_ACCESS_BROWSER=$/m);
  assert.deepEqual(await f.events(), []);
});

test('迁移失败只提示一行警告，不阻塞前置检查', async t => {
  const f = await fixture(t);
  await fs.rm(path.dirname(f.configPath), { recursive: true });
  await fs.writeFile(path.dirname(f.configPath), '占位文件，使数据目录无法创建');
  await fs.writeFile(path.join(f.skill, 'config.env'), 'WEB_ACCESS_BROWSER=chrome\n');
  const proxy = await fakeProxy(t);
  const result = await f.run(proxy.port);
  success(result);
  assert.equal(result.stdout.split('\n').filter(line => line.startsWith('user-data: warn')).length, 1);
  assert.equal(await fs.readFile(path.join(f.skill, 'config.env'), 'utf8'), 'WEB_ACCESS_BROWSER=chrome\n');
});

async function unusedPort() {
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

for (const scenario of ['unset', 'invalid', 'offline', 'maintenance']) {
  test(`本地站点经验不依赖浏览器就绪：${scenario} 退出前仍列出文件与目录`, async t => {
    const f = await fixture(t, { configured: scenario === 'invalid' ? 'not-a-data-directory' : scenario === 'offline' ? 'chrome' : null });
    const patterns = path.join(f.home, '.web-access', 'site-patterns');
    await fs.mkdir(path.join(patterns, 'archive'), { recursive: true });
    await fs.writeFile(path.join(patterns, 'example.com.md'), 'local guidance');
    await fs.writeFile(path.join(patterns, 'ignore.txt'), 'not a site pattern');
    const port = scenario === 'maintenance'
      ? (await fakeProxy(t, { maintenance: true })).port
      : await unusedPort();
    const extraEnv = scenario === 'offline' ? { TEST_SELECT: JSON.stringify({
      kind: 'unavailable', source: 'preference', reason: 'offline', port: 9222,
      browser: { id: legacyDataDir(f, 'chrome'), label: 'Chrome' },
    }) } : {};
    const result = await f.run(port, [], extraEnv);
    assert.equal(result.code, scenario === 'unset' ? 2 : 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /site-patterns: example\.com/);
    assert.equal(result.stdout.split('site-patterns:').length - 1, 1);
    assert.ok(result.stdout.includes(patterns), result.stdout);
    assert.ok(result.stdout.indexOf('site-patterns:') < result.stdout.search(/browser:|proxy:/), result.stdout);
    assert.doesNotMatch(result.stdout, /site-patterns:.*(?:ignore|archive)/);
    assert.equal((await f.events()).filter(event => event.action === 'spawn').length, 0);
  });
}

test('未设置浏览器时 exit 2：列出应用数据根目录的最外层文件夹名与探测命令，不进入文件夹、不启动服务', async t => {
  const f = await fixture(t, { dataDirs: false });
  const root = appDataRoot(f);
  await fs.mkdir(path.join(root, 'Dia', 'User Data', 'NestedProfileMarker'), { recursive: true });
  await fs.mkdir(path.join(root, 'Google', 'Chrome'), { recursive: true });
  await fs.writeFile(path.join(root, 'loose-file.txt'), 'x');
  const result = await f.run(await unusedPort());
  assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /browser: 未设置/);
  assert.ok(result.stdout.includes(`应用数据根目录 ${root} 下的文件夹：`), result.stdout);
  assert.match(result.stdout, /^ {4}Dia, Google$/m);
  assert.doesNotMatch(result.stdout, /NestedProfileMarker|User Data|loose-file/);
  assert.ok(result.stdout.includes(path.join(f.skill, 'scripts', 'browser-probe.mjs')), result.stdout);
  assert.match(result.stdout, /即使只找到一个也要问/);
  assert.ok(result.stdout.includes(`${f.configPath}：WEB_ACCESS_BROWSER=<数据目录路径>`), result.stdout);
  assert.ok(result.stdout.includes('chrome://inspect/#remote-debugging'));
  assert.ok(result.stdout.includes('edge://inspect/#remote-debugging'));
  const events = await f.events();
  assert.equal(events.filter(event => event.action === 'selectBrowser').length, 1);
  assert.equal(events.filter(event => event.action === 'spawn').length, 0);
});

test('所选浏览器不可用时 exit 1：用显示名给出处理顺序与通用 inspect 地址，不启动服务', async t => {
  const f = await fixture(t, { configured: '~/Dia/User Data' });
  const select = {
    kind: 'unavailable', source: 'preference', reason: 'not-enabled',
    browser: { id: path.join(f.home, 'Dia', 'User Data'), label: 'Dia' },
  };
  const result = await f.run(await unusedPort(), [], { TEST_SELECT: JSON.stringify(select) });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /browser: error — 默认偏好的浏览器 Dia/);
  assert.match(result.stdout, /先用系统命令打开 Dia/);
  assert.ok(result.stdout.includes('chrome://inspect/#remote-debugging'));
  assert.ok(result.stdout.includes('edge://inspect/#remote-debugging'));
  assert.match(result.stdout, /也可以编辑/);
  assert.deepEqual((await f.events()).filter(event => event.action === 'spawn'), []);
});

for (const { name, configured, running } of [
  { name: '旧配置 chrome 复用报告标准路径的新实例', configured: 'chrome', running: f => legacyDataDir(f, 'chrome') },
  { name: '路径配置复用升级前报告旧值 chrome 的实例', configured: null, running: () => 'chrome' },
  { name: '~ 写法的路径配置复用报告绝对路径的实例', configured: '~/Dia/User Data/', running: f => path.join(f.home, 'Dia', 'User Data') },
]) {
  test(`浏览器身份按数据目录比较：${name}`, async t => {
    const f = await fixture(t, { configured });
    if (!configured) await fs.writeFile(f.configPath, `WEB_ACCESS_BROWSER=${legacyDataDir(f, 'chrome')}\n`);
    const proxy = await fakeProxy(t, { browser: running(f) });
    success(await f.run(proxy.port));
    assert.deepEqual(await f.events(), []);
  });
}

test('路径配置与运行实例的数据目录不同则明确不一致，保留原服务', async t => {
  const f = await fixture(t, { configured: '~/Dia/User Data' });
  const proxy = await fakeProxy(t, { browser: legacyDataDir(f, 'chrome') });
  const result = await f.run(proxy.port);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /浏览器不一致 — 当前实例使用 .*，但本次需要 Dia/);
  assert.deepEqual(await f.events(), []);
});

test('没有服务时按配置的数据目录启动，Proxy 报告规范化路径', async t => {
  const f = await fixture(t, { configured: '~/Dia/User Data/' });
  const port = await unusedPort();
  success(await f.run(port));
  const events = await f.events();
  assert.deepEqual(events.find(event => event.action === 'spawn').args, []);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.deepEqual(health.browser, { id: path.join(f.home, 'Dia', 'User Data'), label: 'Dia' });
});

// 审查应修-3：值本身无效时，与共享服务是否在运行无关，先报配置错误，不引导停止共享服务。
for (const { name, configured, args = [], setup, pattern } of [
  { name: '只写文件夹名', configured: 'Dia', pattern: /既不是浏览器数据目录的绝对路径/ },
  { name: '相对路径', configured: 'Google/Chrome', pattern: /既不是浏览器数据目录的绝对路径/ },
  { name: 'CLI 浏览器名拼写错误', args: ['--browser', 'chrmoe'], pattern: /--browser 的值无效/ },
  { name: '目录不存在', configured: '~/NoSuch/User Data', pattern: /不存在或不是文件夹/ },
  { name: '不是 Chromium 数据目录', configured: '~/Dia', pattern: /没有 Local State/ },
]) {
  for (const running of [true, false]) {
    test(`配置值无效（${name}）时${running ? '即使共享服务在运行也' : ''}先报配置错误，不提示停止服务`, async t => {
      const f = await fixture(t, { configured });
      const port = running ? (await fakeProxy(t, { browser: 'chrome' })).port : await unusedPort();
      const result = await f.run(port, args);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stdout, /browser: 配置错误 — /);
      assert.match(result.stdout, pattern);
      assert.match(result.stdout, /含 Local State 的那一层/);
      assert.match(result.stdout, /不需要停止或重启共享服务/);
      assert.doesNotMatch(result.stdout, /浏览器不一致|proxy-maintenance\.mjs stop/);
      assert.deepEqual(await f.events(), []);
    });
  }
}

test('经软链接写的数据目录与运行实例报告的真实路径视为同一浏览器', async t => {
  const f = await fixture(t);
  const link = path.join(f.root, 'links', 'chrome');
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(legacyDataDir(f, 'chrome'), link);
  await fs.writeFile(f.configPath, `WEB_ACCESS_BROWSER=${link}\n`);
  const proxy = await fakeProxy(t, { browser: legacyDataDir(f, 'chrome') });
  success(await f.run(proxy.port));
  assert.deepEqual(await f.events(), []);
});

// 审查应修-4：迁移失败的那次运行若从模板创建了空 config.env，下次重试时旧偏好会被 COPYFILE_EXCL 跳过而悄悄丢失。
test('迁移失败的运行不创建模板配置，下次重试仍能迁入旧偏好', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && '需要非 root 的 POSIX' }, async t => {
  const f = await fixture(t);
  await fs.rm(path.dirname(f.configPath), { recursive: true });
  await fs.copyFile(path.join(SCRIPTS, '..', 'templates', 'config.env.template'), path.join(f.skill, 'templates', 'config.env.template'));
  await fs.writeFile(path.join(f.skill, 'config.env'), 'WEB_ACCESS_BROWSER=chrome\n');
  const locked = path.join(f.skill, 'references', 'site-patterns', 'archive');
  await fs.mkdir(locked, { recursive: true });
  await fs.chmod(locked, 0o000);
  const proxy = await fakeProxy(t, { browser: 'chrome' });
  let first;
  try { first = await f.run(proxy.port); }
  finally { await fs.chmod(locked, 0o755); }
  assert.equal(first.stdout.split('\n').filter(line => line.startsWith('user-data: warn')).length, 1, first.stdout);
  assert.doesNotMatch(first.stdout, /已从模板创建/);
  assert.equal(await fs.access(f.configPath).then(() => true, () => false), false);

  const second = await f.run(proxy.port);
  success(second);
  assert.match(second.stdout, /^user-data: 已迁移 config\.env/m);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), 'WEB_ACCESS_BROWSER=chrome\n');
});
