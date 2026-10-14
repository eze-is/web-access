import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

// 操作系统分支在子进程内模拟；真实文件/TCP 均位于临时树与随机端口。
async function fixture(t, { platform = 'darwin', config = '', envPreference = '' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Web Access discovery with spaces '));
  const scripts = path.join(root, 'scripts');
  const home = path.join(root, 'User Name', 'Home Directory');
  const localAppData = path.join(root, 'User Name', 'AppData', 'Local Data');
  await fs.mkdir(scripts, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(localAppData, { recursive: true });
  const configPath = path.join(root, 'config.env');
  if (config !== null) await fs.writeFile(configPath, config);
  await fs.copyFile(path.join(SCRIPTS, 'browser-discovery.mjs'), path.join(scripts, 'browser-discovery.mjs'));
  // 通用扫描在各平台读取的浏览器用户数据目录根
  const platformRoot = platform === 'win32' ? localAppData
    : platform === 'linux' ? path.join(home, '.config')
    : path.join(home, 'Library', 'Application Support');
  const probe = path.join(root, 'probe.mjs');
  await fs.writeFile(probe, `
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const opts = JSON.parse(process.argv[2]);
os.platform = () => opts.platform;
os.homedir = () => opts.home;
let connections = 0;
const originalConnect = net.createConnection;
net.createConnection = (...args) => {
  connections++;
  if (opts.rejectTcp) throw new Error('TCP forbidden for this operation');
  return originalConnect(...args);
};
const reads = [];
const originalRead = fs.readFileSync;
fs.readFileSync = (filename, ...args) => {
  const pathname = String(filename);
  if (path.basename(pathname) === 'DevToolsActivePort') {
    reads.push(pathname);
    const code = opts.deniedPaths?.[pathname];
    if (code) throw Object.assign(new Error('模拟端口文件权限拒绝'), { code });
  }
  return originalRead(filename, ...args);
};
const discovery = await import(pathToFileURL(opts.modulePath));
let result;
if (opts.action === 'windowsPaths') {
  // 模块级 Skill 根路径使用宿主路径；仅路径映射调用使用 Windows 原生分隔规则。
  path.join = path.win32.join;
  result = discovery.knownBrowsers();
} else if (opts.action === 'known') {
  result = discovery.knownBrowsers();
} else if (opts.action === 'configured') {
  result = discovery.getConfiguredBrowserId();
} else if (opts.action === 'checkPort') {
  result = await discovery.checkPort(opts.port, '127.0.0.1', 100);
} else if (opts.action === 'scan') {
  result = discovery.scanDevToolsActivePort();
} else {
  result = await discovery.selectBrowser(opts.override ?? null);
}
console.log(JSON.stringify({ result, connections, ...(opts.recordReads ? { reads } : {}) }));
`);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = async (action = 'select', extra = {}) => {
    const options = { action, platform, home, modulePath: path.join(scripts, 'browser-discovery.mjs'), ...extra };
    const child = spawn(process.execPath, [probe, JSON.stringify(options)], {
      env: { ...process.env, LOCALAPPDATA: extra.localAppData ?? localAppData, WEB_ACCESS_BROWSER: envPreference },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.equal(code, 0, `${stdout}\n${stderr}`);
      return JSON.parse(stdout.trim());
    } finally { clearTimeout(watchdog); }
  };
  return {
    root, home, localAppData, configPath, platformRoot, run,
    async devTools(id, content) {
      const { result: browsers } = await run('known');
      const browser = browsers.find(item => item.id === id);
      assert.ok(browser, `测试平台 ${platform} 不支持 ${id}`);
      await fs.mkdir(path.dirname(browser.devToolsPath), { recursive: true });
      await fs.writeFile(browser.devToolsPath, content);
      return browser;
    },
    // 在平台扫描根下按相对路径写白名单外浏览器的端口文件，
    // rel 如 'Dia/User Data/DevToolsActivePort'
    async portFile(rel, content) {
      const target = path.join(platformRoot, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
      return target;
    },
  };
}

async function fakeHttp(t) {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { port: server.address().port, requests: () => requests };
}

const platformPaths = {
  darwin: {
    chrome: 'Library/Application Support/Google/Chrome/DevToolsActivePort',
    'chrome-canary': 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort',
    chromium: 'Library/Application Support/Chromium/DevToolsActivePort',
    edge: 'Library/Application Support/Microsoft Edge/DevToolsActivePort',
  },
  linux: {
    chrome: '.config/google-chrome/DevToolsActivePort',
    chromium: '.config/chromium/DevToolsActivePort',
    edge: '.config/microsoft-edge/DevToolsActivePort',
  },
  win32: {
    chrome: 'Google/Chrome/User Data/DevToolsActivePort',
    chromium: 'Chromium/User Data/DevToolsActivePort',
    edge: 'Microsoft/Edge/User Data/DevToolsActivePort',
  },
};

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform} 浏览器目录映射来自平台根目录，支持路径空格`, async t => {
    const f = await fixture(t, { platform });
    const { result: browsers, connections } = await f.run('known', { rejectTcp: true });
    assert.deepEqual(browsers.map(browser => browser.id), Object.keys(platformPaths[platform]));
    const base = platform === 'win32' ? f.localAppData : f.home;
    for (const browser of browsers) {
      assert.equal(browser.devToolsPath, path.join(base, platformPaths[platform][browser.id]));
      assert.ok(browser.label);
    }
    assert.equal(connections, 0);
  });
}

test('Windows LOCALAPPDATA 含空格时原生反斜杠路径映射正确', async t => {
  const f = await fixture(t, { platform: 'win32' });
  const localAppData = 'C:\\Users\\User Name\\AppData\\Local Data';
  const { result: browsers, connections } = await f.run('windowsPaths', { localAppData, rejectTcp: true });
  for (const browser of browsers) {
    assert.equal(browser.devToolsPath, path.win32.join(localAppData, platformPaths.win32[browser.id]));
    assert.ok(browser.devToolsPath.startsWith('C:\\Users\\User Name\\'));
    assert.ok(!browser.devToolsPath.includes('/'));
  }
  assert.equal(connections, 0);
});

test('不支持的平台返回空浏览器列表，不探测系统端口', async t => {
  const f = await fixture(t, { platform: 'unsupported-os' });
  assert.deepEqual(await f.run('known', { rejectTcp: true }), { result: [], connections: 0 });
  assert.deepEqual(await f.run('select', { rejectTcp: true }), {
    result: { kind: 'empty', detected: [], configured: null, inaccessible: [] }, connections: 0,
  });
});

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform} 临时 DevToolsActivePort 的 CRLF 正确解析，发现仅发送 TCP`, async t => {
    const f = await fixture(t, { platform, config: 'WEB_ACCESS_BROWSER=chrome\r\n' });
    const server = await fakeHttp(t);
    const wsPath = '/devtools/browser/fake-browser-id';
    const browser = await f.devTools('chrome', `${server.port}\r\n${wsPath}\r\n`);
    const { result, connections } = await f.run();
    assert.equal(result.kind, 'ok');
    assert.equal(result.source, 'preference');
    assert.deepEqual(result.browser, { ...browser, port: server.port, wsPath });
    assert.equal(connections, 1);
    assert.equal(server.requests(), 0);
  });
}

test('override 高于 config.env，配置与环境偏好不被修改', async t => {
  const config = '# 默认浏览器\r\nWEB_ACCESS_BROWSER = chrome\r\n';
  const f = await fixture(t, { config, envPreference: 'chromium' });
  const server = await fakeHttp(t);
  await f.devTools('chrome', `${server.port}\n/chrome\n`);
  await f.devTools('edge', `${server.port}\n/edge\n`);
  const { result, connections } = await f.run('select', { override: 'edge' });
  assert.equal(result.kind, 'ok');
  assert.equal(result.source, 'override');
  assert.equal(result.browser.id, 'edge');
  assert.equal(result.configured, 'chrome');
  assert.equal(result.override, 'edge');
  assert.equal(connections, 2);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), config);
  assert.equal(server.requests(), 0);
});

test('配置偏好不在线时严格 mismatch，不降级到已检测的另一浏览器', async t => {
  const f = await fixture(t, { config: 'WEB_ACCESS_BROWSER=edge\n' });
  const server = await fakeHttp(t);
  await f.devTools('chrome', `${server.port}\n/chrome\n`);
  const { result } = await f.run();
  assert.equal(result.kind, 'mismatch');
  assert.equal(result.source, 'preference');
  assert.equal(result.configured, 'edge');
  assert.deepEqual(result.detected.map(browser => browser.id), ['chrome']);
  assert.equal(result.browser, undefined);
});

for (const override of ['edge', 'chrmoe']) {
  test(`override ${override} 不在线时严格 mismatch，不回退到配置 chrome`, async t => {
    const f = await fixture(t, { config: 'WEB_ACCESS_BROWSER=chrome\n' });
    const server = await fakeHttp(t);
    await f.devTools('chrome', `${server.port}\n/chrome\n`);
    const { result } = await f.run('select', { override });
    assert.equal(result.kind, 'mismatch');
    assert.equal(result.source, 'override');
    assert.equal(result.configured, 'chrome');
    assert.equal(result.override, override);
    assert.equal(result.browser, undefined);
  });
}

for (const ids of [['chrome'], ['chrome', 'edge']]) {
  test(`没有偏好、检测到 ${ids.length} 个浏览器时保持 ambiguous`, async t => {
    const f = await fixture(t);
    const server = await fakeHttp(t);
    for (const id of ids) await f.devTools(id, `${server.port}\n/${id}\n`);
    const { result, connections } = await f.run();
    assert.equal(result.kind, 'ambiguous');
    assert.equal(result.configured, null);
    assert.deepEqual(result.detected.map(browser => browser.id), ids);
    assert.equal(result.browser, undefined);
    assert.equal(connections, ids.length);
  });
}

test('没有端口文件和偏好时 empty，环境变量不冒充持久偏好', async t => {
  const f = await fixture(t, { envPreference: 'edge' });
  assert.deepEqual(await f.run('select', { rejectTcp: true }), {
    result: { kind: 'empty', detected: [], configured: null, inaccessible: [] }, connections: 0,
  });
});

for (const config of [null, '# 注释\r\nWEB_ACCESS_BROWSER=\r\n', '# 注释\r\n WEB_ACCESS_BROWSER = edge \r\nignored-line\r\n']) {
  test(`getConfiguredBrowserId ${config?.includes('edge') ? '读取 CRLF/空格偏好' : '缺失或空偏好'} 无需 TCP`, async t => {
    const f = await fixture(t, { config, envPreference: 'chrome' });
    const server = await fakeHttp(t);
    await f.devTools('chrome', `${server.port}\n/chrome\n`);
    const { result, connections } = await f.run('configured', { rejectTcp: true });
    assert.equal(result, config?.includes('edge') ? 'edge' : null);
    assert.equal(connections, 0);
    assert.equal(server.requests(), 0);
  });
}

test('非法和越界端口文件被忽略，不发 TCP', async t => {
  const f = await fixture(t);
  await f.devTools('chrome', '0\r\n/fake\r\n');
  await f.devTools('edge', '65536\r\n/fake\r\n');
  await f.devTools('chromium', 'not-a-port\r\n/fake\r\n');
  assert.deepEqual(await f.run('select', { rejectTcp: true }), {
    result: { kind: 'empty', detected: [], configured: null, inaccessible: [] }, connections: 0,
  });
});

test('端口文件陈旧且 TCP 未监听时不可选中浏览器', async t => {
  const f = await fixture(t, { config: 'WEB_ACCESS_BROWSER=chrome\n' });
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await f.devTools('chrome', `${port}\n/fake\n`);
  const { result, connections } = await f.run();
  assert.equal(result.kind, 'mismatch');
  assert.deepEqual(result.detected, []);
  assert.equal(connections, 1);
});

test('checkPort 检测随机 HTTP 端口，仅建立 TCP，不发送 HTTP/CDP', async t => {
  const f = await fixture(t);
  const server = await fakeHttp(t);
  assert.deepEqual(await f.run('checkPort', { port: server.port }), { result: true, connections: 1 });
  assert.equal(server.requests(), 0);
});

test('显式端口与配置浏览器绑定，跳过其不可读文件且仅建立 TCP', async t => {
  const server = await fakeHttp(t);
  const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=chrome\r\nWEB_ACCESS_CDP_PORT=${server.port}\r\n` });
  const { result: browsers } = await f.run('known');
  const chrome = browsers.find(browser => browser.id === 'chrome');
  const { result, connections, reads } = await f.run('select', {
    deniedPaths: { [chrome.devToolsPath]: 'EPERM' }, recordReads: true,
  });
  assert.equal(result.kind, 'ok');
  assert.equal(result.source, 'preference');
  assert.deepEqual(result.browser, { ...chrome, port: server.port, wsPath: null, endpointSource: 'config-port' });
  assert.deepEqual(result.inaccessible, []);
  assert.ok(!reads.includes(chrome.devToolsPath));
  assert.equal(connections, 1);
  assert.equal(server.requests(), 0);
});

test('override 其它浏览器只使用自己的端口文件，不借用 Chrome 显式端口', async t => {
  const chromeServer = await fakeHttp(t);
  const edgeServer = await fakeHttp(t);
  const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=chrome\nWEB_ACCESS_CDP_PORT=${chromeServer.port}\n` });
  await f.devTools('edge', `${edgeServer.port}\r\n/edge-own-endpoint\r\n`);
  const { result } = await f.run('select', { override: 'edge' });
  assert.equal(result.kind, 'ok');
  assert.equal(result.source, 'override');
  assert.equal(result.browser.id, 'edge');
  assert.equal(result.browser.port, edgeServer.port);
  assert.equal(result.browser.wsPath, '/edge-own-endpoint');
  assert.equal(result.browser.endpointSource, undefined);
  assert.equal(result.detected.find(browser => browser.id === 'chrome').endpointSource, 'config-port');
  assert.equal(chromeServer.requests(), 0);
  assert.equal(edgeServer.requests(), 0);
});

test('override Edge 不可发现时保持 mismatch，已配置 Chrome 显式端口不成为兜底', async t => {
  const server = await fakeHttp(t);
  const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=chrome\nWEB_ACCESS_CDP_PORT=${server.port}\n` });
  const { result } = await f.run('select', { override: 'edge' });
  assert.equal(result.kind, 'mismatch');
  assert.equal(result.source, 'override');
  assert.equal(result.override, 'edge');
  assert.equal(result.configured, 'chrome');
  assert.equal(result.browser, undefined);
  assert.deepEqual(result.detected.map(browser => browser.id), ['chrome']);
});

test('显式端口离线时不回退到同浏览器的可用文件端口', async t => {
  const fileServer = await fakeHttp(t);
  const closed = http.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const offlinePort = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=chrome\nWEB_ACCESS_CDP_PORT=${offlinePort}\n` });
  const chrome = await f.devTools('chrome', `${fileServer.port}\n/file-endpoint\n`);
  const { result, connections, reads } = await f.run('select', { recordReads: true });
  assert.equal(result.kind, 'mismatch');
  assert.deepEqual(result.detected, []);
  assert.ok(!reads.includes(chrome.devToolsPath));
  assert.equal(connections, 1);
  assert.equal(fileServer.requests(), 0);
});

test('显式端口缺 WEB_ACCESS_BROWSER 时返回配置错误，override 也不能补绑定', async t => {
  const f = await fixture(t, { config: 'WEB_ACCESS_CDP_PORT=9222\n' });
  const { result, connections } = await f.run('select', { override: 'chrome', rejectTcp: true });
  assert.equal(result.kind, 'config-error');
  assert.match(result.message, /一起配置/);
  assert.equal(result.configured, null);
  assert.deepEqual(result.detected, []);
  assert.equal(connections, 0);
});

for (const { platform, configured } of [
  { platform: 'darwin', configured: 'unknown-browser' },
  { platform: 'win32', configured: 'chrome-canary' },
]) {
  test(`显式端口绑定 ${platform} 不支持的 ${configured} 时返回配置错误`, async t => {
    const f = await fixture(t, { platform, config: `WEB_ACCESS_BROWSER=${configured}\nWEB_ACCESS_CDP_PORT=9222\n` });
    const { result, connections } = await f.run('select', { rejectTcp: true });
    assert.equal(result.kind, 'config-error');
    assert.match(result.message, /支持列表/);
    assert.equal(connections, 0);
  });
}

for (const port of ['0', '65536', '12junk', '-1', '1.5', '0x2406', '1e3', '+9222']) {
  test(`显式端口 ${JSON.stringify(port)} 不满足十进制范围时返回配置错误`, async t => {
    const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=chrome\nWEB_ACCESS_CDP_PORT=${port}\n` });
    const { result, connections } = await f.run('select', { rejectTcp: true });
    assert.equal(result.kind, 'config-error');
    assert.match(result.message, /1 到 65535 的十进制整数/);
    assert.equal(connections, 0);
  });
}

for (const configured of [false, true]) {
  test(`真实配置模板的空端口使用自动发现（设置浏览器=${configured}）`, async t => {
    let config = await fs.readFile(path.join(SCRIPTS, '..', 'templates', 'config.env.template'), 'utf8');
    if (configured) config = config.replace('WEB_ACCESS_BROWSER=', 'WEB_ACCESS_BROWSER=chrome');
    const f = await fixture(t, { config });
    const server = await fakeHttp(t);
    await f.devTools('chrome', `${server.port}\r\n/devtools/browser/fake\r\n`);
    const { result } = await f.run('select');
    assert.equal(result.kind, configured ? 'ok' : 'ambiguous');
    if (configured) assert.equal(result.browser.port, server.port);
  });
}

for (const code of ['EPERM', 'EACCES']) {
  for (const configured of [null, 'chrome']) {
    test(`${code} 端口文件不可读时保持 ${configured ? 'mismatch' : 'empty'} 且保留不可读事实`, async t => {
      const f = await fixture(t, { config: configured ? `WEB_ACCESS_BROWSER=${configured}\n` : '' });
      const { result: browsers } = await f.run('known');
      const chrome = browsers.find(browser => browser.id === 'chrome');
      const { result, connections } = await f.run('select', { deniedPaths: { [chrome.devToolsPath]: code }, rejectTcp: true });
      assert.equal(result.kind, configured ? 'mismatch' : 'empty');
      assert.deepEqual(result.inaccessible, [{ ...chrome, code }]);
      assert.deepEqual(result.detected, []);
      assert.equal(connections, 0);
    });
  }
}

test('显式 Chrome 端口成功时仍保留另一个浏览器不可读的事实', async t => {
  const server = await fakeHttp(t);
  const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=chrome\nWEB_ACCESS_CDP_PORT=${server.port}\n` });
  const { result: browsers } = await f.run('known');
  const edge = browsers.find(browser => browser.id === 'edge');
  const { result } = await f.run('select', { deniedPaths: { [edge.devToolsPath]: 'EACCES' } });
  assert.equal(result.kind, 'ok');
  assert.equal(result.browser.id, 'chrome');
  assert.deepEqual(result.inaccessible, [{ ...edge, code: 'EACCES' }]);
});

// --- 通用扫描（DevToolsActivePort 兜底）与发现模式 ---

// 各平台扫描根下的典型目录层级 → 推断 id/label（覆盖 vendor、vendor/User Data、
// vendor/product、vendor/product/User Data 四种形态）
const scanCases = {
  darwin: [
    { rel: 'Vivaldi/DevToolsActivePort', id: 'vivaldi', label: 'Vivaldi' },
    { rel: 'Dia/User Data/DevToolsActivePort', id: 'dia', label: 'Dia' },
    { rel: 'BraveSoftware/Brave-Browser/DevToolsActivePort', id: 'bravesoftware-brave-browser', label: 'BraveSoftware Brave-Browser' },
  ],
  linux: [
    { rel: 'vivaldi/DevToolsActivePort', id: 'vivaldi', label: 'vivaldi' },
    { rel: 'dia/User Data/DevToolsActivePort', id: 'dia', label: 'dia' },
    { rel: 'BraveSoftware/Brave-Browser/DevToolsActivePort', id: 'bravesoftware-brave-browser', label: 'BraveSoftware Brave-Browser' },
  ],
  win32: [
    { rel: 'Vivaldi/User Data/DevToolsActivePort', id: 'vivaldi', label: 'Vivaldi' },
    { rel: 'Dia/User Data/DevToolsActivePort', id: 'dia', label: 'Dia' },
    { rel: 'BraveSoftware/Brave-Browser/DevToolsActivePort', id: 'bravesoftware-brave-browser', label: 'BraveSoftware Brave-Browser' },
    { rel: 'Google/Chrome/User Data/DevToolsActivePort', id: 'google-chrome', label: 'Google Chrome' },
  ],
};

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform} 通用扫描覆盖各目录层级，id/label 由路径推断，不发 TCP`, async t => {
    const f = await fixture(t, { platform });
    for (const spec of scanCases[platform]) {
      await f.portFile(spec.rel, '12345\n/devtools/browser/fake\n');
    }
    const { result: browsers, connections } = await f.run('scan', { rejectTcp: true });
    // 扫描顺序来自目录遍历，不构成语义契约——按集合比较
    assert.deepEqual(browsers.map(browser => browser.id).sort(), scanCases[platform].map(spec => spec.id).sort());
    for (const browser of browsers) {
      const spec = scanCases[platform].find(item => item.id === browser.id);
      assert.equal(browser.devToolsPath, path.join(f.platformRoot, spec.rel));
      assert.equal(browser.label, spec.label);
    }
    assert.equal(connections, 0);
  });
}

test('扫描忽略无端口文件的目录，同 id 去重保留第一份', async t => {
  const f = await fixture(t);
  await f.portFile('JetBrains/Settings/other.json', '{}');
  await f.portFile('SomeBrowser/DevToolsActivePort', '1111\n/a\n');
  await f.portFile('SomeBrowser/User Data/DevToolsActivePort', '2222\n/b\n');
  const { result: browsers, connections } = await f.run('scan', { rejectTcp: true });
  assert.equal(browsers.length, 1);
  assert.equal(browsers[0].id, 'somebrowser');
  assert.equal(browsers[0].devToolsPath, path.join(f.platformRoot, 'SomeBrowser/DevToolsActivePort'));
  assert.equal(connections, 0);
});

test('目录存在但无 DevToolsActivePort 文件时扫描安静返回未发现', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.platformRoot, 'Dia', 'User Data'), { recursive: true });
  await fs.mkdir(path.join(f.platformRoot, 'Google', 'Chrome'), { recursive: true });
  assert.deepEqual(await f.run('scan', { rejectTcp: true }), { result: [], connections: 0 });
  assert.deepEqual(await f.run('select', { rejectTcp: true }), {
    result: { kind: 'empty', detected: [], configured: null, inaccessible: [] }, connections: 0,
  });
});

test('auto 模式白名单优先：白名单命中保持原条目，扫描只补白名单外浏览器', async t => {
  const f = await fixture(t);
  const server = await fakeHttp(t);
  const chrome = await f.devTools('chrome', `${server.port}\n/chrome\n`);
  const diaPath = await f.portFile('Dia/User Data/DevToolsActivePort', `${server.port}\n/dia\n`);
  const { result, connections } = await f.run();
  assert.equal(result.kind, 'ambiguous');
  assert.deepEqual(result.detected.map(browser => browser.id), ['chrome', 'dia']);
  const chromeDetected = result.detected.find(browser => browser.id === 'chrome');
  assert.equal(chromeDetected.label, 'Chrome');
  assert.equal(chromeDetected.devToolsPath, chrome.devToolsPath);
  const dia = result.detected.find(browser => browser.id === 'dia');
  assert.equal(dia.label, 'Dia');
  assert.equal(dia.devToolsPath, diaPath);
  assert.equal(dia.port, server.port);
  assert.equal(dia.wsPath, '/dia');
  assert.equal(connections, 2);
  assert.equal(server.requests(), 0);
});

test('auto 模式扫描不重复白名单已覆盖的浏览器', async t => {
  const f = await fixture(t, { config: 'WEB_ACCESS_BROWSER=chrome\n' });
  const server = await fakeHttp(t);
  await f.devTools('chrome', `${server.port}\n/chrome\n`);
  const { result, connections } = await f.run();
  assert.equal(result.kind, 'ok');
  assert.deepEqual(result.detected.map(browser => browser.id), ['chrome']);
  assert.equal(result.detected[0].label, 'Chrome');
  assert.equal(connections, 1);
});

test('auto 模式白名单未命中时由扫描兜底，偏好可指向扫描发现的浏览器', async t => {
  const f = await fixture(t, { config: 'WEB_ACCESS_BROWSER=dia\n' });
  const server = await fakeHttp(t);
  await f.portFile('Dia/User Data/DevToolsActivePort', `${server.port}\r\n/devtools/browser/fake-dia\r\n`);
  const { result, connections } = await f.run();
  assert.equal(result.kind, 'ok');
  assert.equal(result.source, 'preference');
  assert.equal(result.browser.id, 'dia');
  assert.equal(result.browser.label, 'Dia');
  assert.equal(result.browser.port, server.port);
  assert.equal(result.browser.wsPath, '/devtools/browser/fake-dia');
  assert.equal(connections, 1);
  assert.equal(server.requests(), 0);
});

test('auto 模式 override 可指定扫描发现的浏览器', async t => {
  const f = await fixture(t);
  const server = await fakeHttp(t);
  await f.devTools('chrome', `${server.port}\n/chrome\n`);
  await f.portFile('Dia/User Data/DevToolsActivePort', `${server.port}\n/dia\n`);
  const { result } = await f.run('select', { override: 'dia' });
  assert.equal(result.kind, 'ok');
  assert.equal(result.source, 'override');
  assert.equal(result.browser.id, 'dia');
  assert.equal(result.browser.label, 'Dia');
  assert.equal(result.browser.port, server.port);
});

test('auto 模式显式端口可绑定扫描发现的浏览器，跳过其不可读文件', async t => {
  const server = await fakeHttp(t);
  const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=dia\nWEB_ACCESS_CDP_PORT=${server.port}\n` });
  const diaPath = await f.portFile('Dia/User Data/DevToolsActivePort', '1\r\n/stale\n');
  const { result, connections, reads } = await f.run('select', {
    deniedPaths: { [diaPath]: 'EPERM' }, recordReads: true,
  });
  assert.equal(result.kind, 'ok');
  assert.equal(result.source, 'preference');
  assert.equal(result.browser.id, 'dia');
  assert.equal(result.browser.port, server.port);
  assert.equal(result.browser.endpointSource, 'config-port');
  assert.ok(!reads.includes(diaPath));
  assert.equal(connections, 1);
  assert.equal(server.requests(), 0);
});

test('auto 模式扫描候选的端口文件不可读时保留不可读事实', async t => {
  const f = await fixture(t);
  const diaPath = await f.portFile('Dia/User Data/DevToolsActivePort', '1234\n/dia\n');
  const { result, connections } = await f.run('select', { deniedPaths: { [diaPath]: 'EACCES' }, rejectTcp: true });
  assert.equal(result.kind, 'empty');
  assert.deepEqual(result.inaccessible, [{ id: 'dia', label: 'Dia', devToolsPath: diaPath, code: 'EACCES' }]);
  assert.deepEqual(result.detected, []);
  assert.equal(connections, 0);
});

test('whitelist 模式不扫描：白名单外浏览器保持不可见', async t => {
  const f = await fixture(t, { config: 'WEB_ACCESS_BROWSER_DISCOVERY=whitelist\n' });
  const server = await fakeHttp(t);
  await f.devTools('chrome', `${server.port}\n/chrome\n`);
  await f.portFile('Dia/User Data/DevToolsActivePort', `${server.port}\n/dia\n`);
  const { result, connections } = await f.run();
  assert.equal(result.kind, 'ambiguous');
  assert.deepEqual(result.detected.map(browser => browser.id), ['chrome']);
  assert.equal(connections, 1);
});

test('whitelist 模式只有白名单外浏览器（端口在线）时保持 empty', async t => {
  const f = await fixture(t, { config: 'WEB_ACCESS_BROWSER_DISCOVERY=whitelist\n' });
  const server = await fakeHttp(t);
  await f.portFile('Dia/User Data/DevToolsActivePort', `${server.port}\n/dia\n`);
  assert.deepEqual(await f.run('select', { rejectTcp: true }), {
    result: { kind: 'empty', detected: [], configured: null, inaccessible: [] }, connections: 0,
  });
});

test('scan 模式只用扫描：白名单路径以路径推断的 id/label 出现', async t => {
  const server = await fakeHttp(t);
  const f = await fixture(t, { config: 'WEB_ACCESS_BROWSER_DISCOVERY=scan\r\nWEB_ACCESS_BROWSER=google-chrome\r\n' });
  await f.devTools('chrome', `${server.port}\n/chrome\n`);
  const { result, connections } = await f.run();
  assert.equal(result.kind, 'ok');
  assert.equal(result.source, 'preference');
  assert.equal(result.browser.id, 'google-chrome');
  assert.equal(result.browser.label, 'Google Chrome');
  assert.deepEqual(result.detected.map(browser => browser.id), ['google-chrome']);
  assert.equal(connections, 1);
});

test('scan 模式白名单 id 不再是候选，保持 mismatch', async t => {
  const server = await fakeHttp(t);
  const f = await fixture(t, { config: 'WEB_ACCESS_BROWSER_DISCOVERY=scan\nWEB_ACCESS_BROWSER=chrome\n' });
  await f.devTools('chrome', `${server.port}\n/chrome\n`);
  const { result } = await f.run();
  assert.equal(result.kind, 'mismatch');
  assert.equal(result.source, 'preference');
  assert.deepEqual(result.detected.map(browser => browser.id), ['google-chrome']);
});

test('scan 模式显式端口可绑定当前未被扫描到的浏览器', async t => {
  const server = await fakeHttp(t);
  const f = await fixture(t, { config: `WEB_ACCESS_BROWSER_DISCOVERY=scan\nWEB_ACCESS_BROWSER=dia\nWEB_ACCESS_CDP_PORT=${server.port}\n` });
  const { result, connections } = await f.run();
  assert.equal(result.kind, 'ok');
  assert.equal(result.source, 'preference');
  assert.equal(result.browser.id, 'dia');
  assert.equal(result.browser.port, server.port);
  assert.equal(result.browser.endpointSource, 'config-port');
  assert.equal(connections, 1);
  assert.equal(server.requests(), 0);
});

for (const mode of ['', 'auto', 'AUTO', ' Scan ']) {
  test(`WEB_ACCESS_BROWSER_DISCOVERY="${mode}" 归一为默认 auto，扫描兜底可用`, async t => {
    const f = await fixture(t, { config: `WEB_ACCESS_BROWSER_DISCOVERY=${mode}\n` });
    const server = await fakeHttp(t);
    await f.portFile('Dia/User Data/DevToolsActivePort', `${server.port}\n/dia\n`);
    const { result, connections } = await f.run();
    assert.equal(result.kind, 'ambiguous');
    assert.deepEqual(result.detected.map(browser => browser.id), ['dia']);
    assert.equal(connections, 1);
  });
}

for (const mode of ['bogus', 'automatic', 'sc an']) {
  test(`WEB_ACCESS_BROWSER_DISCOVERY="${mode}" 非法时返回配置错误，不擅自降级`, async t => {
    const f = await fixture(t, { config: `WEB_ACCESS_BROWSER_DISCOVERY=${mode}\n` });
    const { result, connections } = await f.run('select', { rejectTcp: true });
    assert.equal(result.kind, 'config-error');
    assert.match(result.message, /WEB_ACCESS_BROWSER_DISCOVERY 必须是 auto、whitelist 或 scan/);
    assert.deepEqual(result.detected, []);
    assert.equal(connections, 0);
  });
}
