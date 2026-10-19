import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

// 操作系统分支在子进程内模拟；真实文件/TCP 均位于临时树与随机端口，不读取真实 HOME，也不探测任何固定端口。
// 子进程记录：TCP 连接次数、DevToolsActivePort 读取、目录列举，用来证明「只读所选目录、只做 TCP」。
const PRELOAD = `
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
const opts = JSON.parse(process.env.TEST_OPTS);
os.platform = () => opts.platform;
os.homedir = () => opts.home;
const record = { connections: 0, reads: [], readdirs: [] };
const originalConnect = net.createConnection;
net.createConnection = (...args) => {
  record.connections++;
  if (opts.rejectTcp) throw new Error('TCP forbidden for this operation');
  return originalConnect(...args);
};
const originalRead = fs.readFileSync;
fs.readFileSync = (filename, ...args) => {
  const pathname = String(filename);
  if (path.basename(pathname) === 'DevToolsActivePort') {
    record.reads.push(pathname);
    const code = opts.deniedPaths?.[pathname];
    if (code) throw Object.assign(new Error('模拟端口文件权限拒绝'), { code });
  }
  return originalRead(filename, ...args);
};
const originalReaddir = fs.readdirSync;
fs.readdirSync = (dir, ...args) => { record.readdirs.push(String(dir)); return originalReaddir(dir, ...args); };
globalThis.__testRecord = record;
`;
const RUNNER = `
const opts = JSON.parse(process.env.TEST_OPTS);
const discovery = await import(new URL('./scripts/browser-discovery.mjs', import.meta.url));
// 模块加载用宿主路径；仅被测调用使用 Windows 原生路径规则。
if (opts.winPath) {
  const path = (await import('node:path')).default;
  for (const name of ['join', 'resolve', 'isAbsolute']) path[name] = path.win32[name];
}
const call = async () => {
  switch (opts.action) {
    case 'exports': return Object.keys(discovery).sort();
    case 'resolve': return discovery.resolveBrowser(opts.value);
    case 'same': return discovery.sameBrowser(opts.a, opts.b);
    case 'label': return opts.values.map(value => discovery.displayName(value));
    case 'configured': return discovery.getConfiguredBrowser();
    case 'checkPort': return discovery.checkPort(opts.port, '127.0.0.1', 100);
    case 'explain': return discovery.explainUnavailable(opts.result);
    default: return discovery.selectBrowser(opts.override ?? null);
  }
};
let result;
try { result = await call(); }
catch (error) { result = { thrown: error.message }; }
console.log(JSON.stringify({ result, ...globalThis.__testRecord }));
`;

async function fixture(t, { platform = 'darwin', config = '' } = {}) {
  // 取真实路径：浏览器身份按真实路径规范化（macOS 的临时目录经 /var → /private/var 软链接）
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'Web Access discovery with spaces ')));
  const scripts = path.join(root, 'scripts');
  const home = path.join(root, 'User Name', 'Home Directory');
  const localAppData = path.join(root, 'User Name', 'AppData', 'Local Data');
  const appData = path.join(root, 'User Name', 'AppData', 'Roaming Data');
  await fs.mkdir(scripts, { recursive: true });
  for (const dir of [home, localAppData, appData]) await fs.mkdir(dir, { recursive: true });
  // 偏好位于（模拟的）HOME 下的用户数据目录，与 Skill 副本分离
  const configPath = path.join(home, '.web-access', 'config.env');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  if (config !== null) await fs.writeFile(configPath, config);
  for (const name of ['browser-discovery.mjs', 'user-data.mjs']) {
    await fs.copyFile(path.join(SCRIPTS, name), path.join(scripts, name));
  }
  await fs.writeFile(path.join(root, 'preload.mjs'), PRELOAD);
  await fs.writeFile(path.join(root, 'runner.mjs'), RUNNER);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const run = async (action = 'select', extra = {}) => {
    const { env: extraEnv = {}, ...rest } = extra;
    const options = { action, platform, home, ...rest };
    const child = spawn(process.execPath, ['--import', path.join(root, 'preload.mjs'), path.join(root, 'runner.mjs')], {
      env: {
        ...process.env, TEST_OPTS: JSON.stringify(options),
        LOCALAPPDATA: localAppData, APPDATA: appData, WEB_ACCESS_BROWSER: 'chrome', ...extraEnv,
      },
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
  // 在临时 HOME 下建一个浏览器数据目录；content 为 null 时不写端口文件
  const dataDir = async (relative, content = null) => {
    const dir = path.join(home, relative);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'Local State'), '{}');
    if (content !== null) await fs.writeFile(path.join(dir, 'DevToolsActivePort'), content);
    return dir;
  };
  return { root, home, localAppData, appData, configPath, run, dataDir };
}

async function fakeHttp(t, host = '127.0.0.1') {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.end('{}');
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port: 0, host, ipv6Only: host === '::1' }, resolve);
    });
  } catch (error) {
    if (host !== '::1' || !['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) throw error;
    t.skip('IPv6 loopback is unavailable on this host');
    return null;
  }
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { port: server.address().port, requests: () => requests };
}

async function closedPort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const DIA = 'Library/Application Support/Dia/User Data';
const legacyPaths = {
  darwin: {
    chrome: ['Library/Application Support/Google/Chrome', 'Chrome'],
    'chrome-canary': ['Library/Application Support/Google/Chrome Canary', 'Chrome Canary'],
    chromium: ['Library/Application Support/Chromium', 'Chromium'],
    edge: ['Library/Application Support/Microsoft Edge', 'Microsoft Edge'],
  },
  linux: {
    chrome: ['.config/google-chrome', 'google-chrome'],
    'chrome-canary': ['.config/google-chrome-canary', 'google-chrome-canary'],
    chromium: ['.config/chromium', 'chromium'],
    edge: ['.config/microsoft-edge', 'microsoft-edge'],
  },
};

// --- 身份解析 ---

test('模块不再导出浏览器名单或固定端口兜底', async t => {
  const f = await fixture(t);
  const { result } = await f.run('exports', { rejectTcp: true });
  assert.ok(!result.includes('findFallbackPort'));
  assert.ok(!result.includes('knownBrowsers'));
  for (const name of ['resolveBrowser', 'sameBrowser', 'selectBrowser', 'readActivePort', 'explainUnavailable', 'INSPECT_HINT']) {
    assert.ok(result.includes(name), name);
  }
});

for (const platform of ['darwin', 'linux']) {
  test(`${platform} 旧值按平台映射到标准数据目录，解析不读文件不发 TCP`, async t => {
    const f = await fixture(t, { platform });
    for (const [alias, [relative, label]] of Object.entries(legacyPaths[platform])) {
      const { result, connections, reads, readdirs } = await f.run('resolve', { value: alias, rejectTcp: true });
      assert.deepEqual(result, { id: path.join(f.home, relative), label }, alias);
      assert.equal(connections, 0);
      assert.deepEqual(reads, []);
      assert.deepEqual(readdirs, []);
    }
  });
}

test('Windows 旧值映射到 LOCALAPPDATA，Canary 为 Chrome SxS，路径含空格与反斜杠', async t => {
  const f = await fixture(t, { platform: 'win32' });
  const localAppData = 'C:\\Users\\User Name\\AppData\\Local';
  const expected = {
    chrome: ['Google\\Chrome\\User Data', 'Chrome'],
    'chrome-canary': ['Google\\Chrome SxS\\User Data', 'Chrome SxS'],
    chromium: ['Chromium\\User Data', 'Chromium'],
    edge: ['Microsoft\\Edge\\User Data', 'Edge'],
  };
  for (const [alias, [relative, label]] of Object.entries(expected)) {
    const { result } = await f.run('resolve', { value: alias, winPath: true, rejectTcp: true, env: { LOCALAPPDATA: localAppData } });
    assert.deepEqual(result, { id: `${localAppData}\\${relative}`, label }, alias);
  }
  const missing = await f.run('resolve', { value: 'edge', winPath: true, env: { LOCALAPPDATA: '' } });
  assert.match(missing.result.thrown, /LOCALAPPDATA/);
});

test('Windows 路径展开 %LOCALAPPDATA% / %APPDATA% 与 ~\\，变量缺失时明确报错', async t => {
  const f = await fixture(t, { platform: 'win32' });
  const env = { LOCALAPPDATA: 'C:\\Users\\U N\\AppData\\Local', APPDATA: 'C:\\Users\\U N\\AppData\\Roaming' };
  const cases = [
    ['%LOCALAPPDATA%\\Dia\\User Data', 'C:\\Users\\U N\\AppData\\Local\\Dia\\User Data', 'Dia'],
    ['%appdata%\\Opera Software\\Opera Stable\\', 'C:\\Users\\U N\\AppData\\Roaming\\Opera Software\\Opera Stable', 'Opera Stable'],
    ['"C:\\Program Data\\Vivaldi\\User Data"', 'C:\\Program Data\\Vivaldi\\User Data', 'Vivaldi'],
  ];
  for (const [value, id, label] of cases) {
    const { result } = await f.run('resolve', { value, winPath: true, env });
    assert.deepEqual(result, { id, label }, value);
  }
  const tilde = await f.run('resolve', { value: '~\\AppData\\Local\\Arc\\User Data', winPath: true, home: 'C:\\Users\\U N', env });
  assert.deepEqual(tilde.result, { id: 'C:\\Users\\U N\\AppData\\Local\\Arc\\User Data', label: 'Arc' });
  const missing = await f.run('resolve', { value: '%APPDATA%\\Opera Software\\Opera Stable', winPath: true, env: { APPDATA: '' } });
  assert.match(missing.result.thrown, /APPDATA 未设置/);
});

test('路径写法规范化：展开 ~、去引号、去尾部分隔符和 ..，大小写不敏感的旧值', async t => {
  const f = await fixture(t);
  const dia = path.join(f.home, DIA);
  for (const value of [`~/${DIA}`, `~/${DIA}/`, `"~/${DIA}"`, `'${dia}'`, `${f.home}/Library/Application Support/Other/../Dia/User Data`]) {
    const { result } = await f.run('resolve', { value, rejectTcp: true });
    assert.deepEqual(result, { id: dia, label: 'Dia' }, value);
  }
  const { result } = await f.run('resolve', { value: ' Chrome ' });
  assert.equal(result.id, path.join(f.home, legacyPaths.darwin.chrome[0]));
});

for (const value of ['chrmoe', 'Dia/User Data', 'brave', '', 'constructor']) {
  test(`无效浏览器值 ${JSON.stringify(value)} 明确报错，不猜测`, async t => {
    const f = await fixture(t);
    const { result, connections } = await f.run('resolve', { value, rejectTcp: true });
    assert.ok(result.thrown, JSON.stringify(result));
    if (value) assert.match(result.thrown, /旧配置值/);
    assert.equal(connections, 0);
  });
}

test('显示名取最有辨识度的文件夹名，只跳过通用的 User Data 层', async t => {
  const f = await fixture(t);
  const { result } = await f.run('label', {
    values: [
      '/Users/u/Library/Application Support/Dia/User Data',
      '/Users/u/Library/Application Support/Google/Chrome',
      '/Users/u/Library/Application Support/BraveSoftware/Brave-Browser',
      '/Users/u/Library/Application Support/com.operasoftware.Opera',
      'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data',
      'C:\\Users\\u\\AppData\\Local\\Microsoft\\Edge\\User Data\\',
    ],
  });
  assert.deepEqual(result, ['Dia', 'Chrome', 'Brave-Browser', 'com.operasoftware.Opera', 'Chrome', 'Edge']);
});

test('sameBrowser 按数据目录比较：旧值与标准路径等同，旧版 unknown 与无效值不相等', async t => {
  const f = await fixture(t);
  const chrome = path.join(f.home, legacyPaths.darwin.chrome[0]);
  const cases = [
    [['chrome', chrome], true],
    [[`${chrome}/`, 'Chrome'], true],
    [[`~/${DIA}`, path.join(f.home, DIA)], true],
    [['chrome', 'edge'], false],
    [['chrome', path.join(f.home, DIA)], false],
    [['unknown', 'chrome'], false],
    [['chrmoe', 'chrmoe'], false],
    [[undefined, 'chrome'], false],
  ];
  for (const [[a, b], expected] of cases) {
    assert.equal((await f.run('same', { a, b, rejectTcp: true })).result, expected, `${a} vs ${b}`);
  }
});

// --- 选择 ---

test('没有偏好时 unset：不列目录、不读端口文件、不发 TCP，即使某浏览器已开调试也不自动选用', async t => {
  const f = await fixture(t);
  const server = await fakeHttp(t);
  await f.dataDir(legacyPaths.darwin.chrome[0], `${server.port}\n/devtools/browser/x\n`);
  const outcome = await f.run('select', { rejectTcp: true });
  assert.deepEqual(outcome, { result: { kind: 'unset' }, connections: 0, reads: [], readdirs: [] });
  assert.equal(server.requests(), 0);
});

for (const platform of ['darwin', 'linux']) {
  test(`${platform} 偏好为 Dia 形态路径：CRLF 端口文件解析正确，只读该目录、只发 TCP`, async t => {
    const relative = platform === 'darwin' ? DIA : '.config/dia/User Data';
    const f = await fixture(t, { platform, config: `WEB_ACCESS_BROWSER=~/${relative}\r\n` });
    const server = await fakeHttp(t);
    const wsPath = '/devtools/browser/fake-browser-id';
    const dir = await f.dataDir(relative, `${server.port}\r\n${wsPath}\r\n`);
    const { result, connections, reads, readdirs } = await f.run();
    assert.deepEqual(result, {
      kind: 'ok', source: 'preference',
      browser: { id: dir, label: platform === 'darwin' ? 'Dia' : 'dia', host: '127.0.0.1', port: server.port, wsPath },
    });
    assert.equal(connections, 1);
    assert.deepEqual(reads, [path.join(dir, 'DevToolsActivePort')]);
    assert.deepEqual(readdirs, []);
    assert.equal(server.requests(), 0);
  });
}

for (const endpointSource of ['active-port', 'config-port']) {
  test(`IPv6-only ${endpointSource} 使用同一端口的 ::1，不发送 HTTP/CDP`, async t => {
    const server = await fakeHttp(t, '::1');
    if (!server) return;
    const config = `WEB_ACCESS_BROWSER=~/${DIA}\n` +
      (endpointSource === 'config-port' ? `WEB_ACCESS_CDP_PORT=${server.port}\n` : '');
    const f = await fixture(t, { config });
    const dir = await f.dataDir(DIA, `${server.port}\n/devtools/browser/ipv6-browser\n`);
    const { result, connections, reads, readdirs } = await f.run();
    assert.equal(result.kind, 'ok');
    assert.equal(result.browser.id, dir);
    assert.equal(result.browser.host, '::1');
    assert.equal(result.browser.port, server.port);
    assert.equal(result.browser.wsPath, endpointSource === 'config-port' ? null : '/devtools/browser/ipv6-browser');
    assert.equal(connections, 2, '只在 IPv4 不可达后尝试 IPv6 loopback');
    assert.deepEqual(reads, endpointSource === 'config-port' ? [] : [path.join(dir, 'DevToolsActivePort')]);
    assert.deepEqual(readdirs, []);
    assert.equal(server.requests(), 0);
  });
}

test('老配置 chrome 无需改动即可选中标准 Chrome 目录', async t => {
  const f = await fixture(t, { config: 'WEB_ACCESS_BROWSER=chrome\n' });
  const server = await fakeHttp(t);
  const dir = await f.dataDir(legacyPaths.darwin.chrome[0], `${server.port}\n/devtools/browser/c\n`);
  const { result } = await f.run();
  assert.equal(result.kind, 'ok');
  assert.deepEqual(result.browser, { id: dir, label: 'Chrome', host: '127.0.0.1', port: server.port, wsPath: '/devtools/browser/c' });
});

test('override 高于 config.env，配置文件与环境变量都不参与持久偏好', async t => {
  const config = '# 默认浏览器\r\nWEB_ACCESS_BROWSER = chrome\r\n';
  const f = await fixture(t, { config });
  const server = await fakeHttp(t);
  await f.dataDir(legacyPaths.darwin.chrome[0], `${server.port}\n/chrome\n`);
  const dia = await f.dataDir(DIA, `${server.port}\n/dia\n`);
  const { result, connections } = await f.run('select', { override: dia, env: { WEB_ACCESS_BROWSER: 'edge' } });
  assert.equal(result.kind, 'ok');
  assert.equal(result.source, 'override');
  assert.equal(result.override, dia);
  assert.equal(result.browser.id, dia);
  assert.equal(result.browser.wsPath, '/dia');
  assert.equal(connections, 1);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), config);
});

for (const config of [null, '# 注释\r\nWEB_ACCESS_BROWSER=\r\n', `# 注释\r\n WEB_ACCESS_BROWSER = ~/${DIA} \r\nignored-line\r\n`]) {
  test(`getConfiguredBrowser ${config?.includes('Dia') ? '读取 CRLF/空格偏好原值' : '缺失或空偏好'} 无需 TCP`, async t => {
    const f = await fixture(t, { config });
    const { result, connections } = await f.run('configured', { rejectTcp: true });
    assert.equal(result, config?.includes('Dia') ? `~/${DIA}` : null);
    assert.equal(connections, 0);
  });
}

for (const { name, setup, pattern } of [
  { name: '数据目录不存在', setup: async () => {}, pattern: /不存在或不是文件夹/ },
  { name: '目录里没有 Local State', setup: f => fs.mkdir(path.join(f.home, DIA), { recursive: true }), pattern: /没有 Local State/ },
]) {
  test(`所选值${name}时是配置错误，不发 TCP、不改用其他已开调试的浏览器`, async t => {
    const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=~/${DIA}\n` });
    const server = await fakeHttp(t);
    await f.dataDir(legacyPaths.darwin.chrome[0], `${server.port}\n/chrome\n`);
    await setup(f);
    const { result, connections, readdirs } = await f.run('select', { rejectTcp: true });
    assert.equal(result.kind, 'config-error');
    assert.match(result.message, /^WEB_ACCESS_BROWSER 的值无效/);
    assert.match(result.message, pattern);
    assert.equal(connections, 0);
    assert.deepEqual(readdirs, []);
  });
}

test('身份按真实路径规范化：软链接与大小写不同的写法指向同一目录时视为同一浏览器', async t => {
  const f = await fixture(t);
  const dia = await f.dataDir(DIA);
  const link = path.join(f.home, 'links', 'dia');
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(dia, link);
  assert.equal((await f.run('resolve', { value: link })).result.id, dia);
  assert.equal((await f.run('same', { a: link, b: `~/${DIA}` })).result, true);
  // 大小写不敏感的文件系统（macOS 默认 APFS、Windows）上，不同大小写写法也归一
  const upper = path.join(f.home, DIA.toUpperCase());
  const caseInsensitive = await fs.access(upper).then(() => true, () => false);
  if (caseInsensitive) assert.equal((await f.run('same', { a: upper, b: dia })).result, true);
});

test('目录存在但没有端口文件时 unavailable(not-enabled)', async t => {
  const f = await fixture(t, { config: 'WEB_ACCESS_BROWSER=edge\n' });
  await f.dataDir(legacyPaths.darwin.edge[0]);
  const { result, connections } = await f.run('select', { rejectTcp: true });
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.reason, 'not-enabled');
  assert.equal(result.browser.label, 'Microsoft Edge');
  assert.equal(connections, 0);
});

test('端口文件陈旧且 TCP 未监听时 unavailable(offline)', async t => {
  const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=~/${DIA}\n` });
  const port = await closedPort();
  await f.dataDir(DIA, `${port}\n/fake\n`);
  const { result, connections } = await f.run();
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.reason, 'offline');
  assert.equal(result.port, port);
  assert.equal(connections, 2);
});

for (const content of ['0\r\n/fake\r\n', '65536\n/fake\n', 'not-a-port\n', '12junk\n', '']) {
  test(`端口文件内容 ${JSON.stringify(content)} 无效时 unavailable(invalid)，不发 TCP`, async t => {
    const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=~/${DIA}\n` });
    await f.dataDir(DIA, content);
    const { result, connections } = await f.run('select', { rejectTcp: true });
    assert.equal(result.kind, 'unavailable');
    assert.equal(result.reason, 'invalid');
    assert.equal(connections, 0);
  });
}

for (const code of ['EPERM', 'EACCES']) {
  test(`${code} 端口文件不可读时保留不可读事实（unreadable），不发 TCP`, async t => {
    const f = await fixture(t, { config: 'WEB_ACCESS_BROWSER=chrome\n' });
    const dir = await f.dataDir(legacyPaths.darwin.chrome[0], '9222\n/x\n');
    const { result, connections } = await f.run('select', { deniedPaths: { [path.join(dir, 'DevToolsActivePort')]: code }, rejectTcp: true });
    assert.equal(result.kind, 'unavailable');
    assert.equal(result.reason, 'unreadable');
    assert.equal(result.code, code);
    assert.equal(connections, 0);
  });
}

test('override 值无效时配置错误并点名 --browser，不回退到配置的浏览器', async t => {
  const f = await fixture(t, { config: 'WEB_ACCESS_BROWSER=chrome\n' });
  const { result, connections } = await f.run('select', { override: 'chrmoe', rejectTcp: true });
  assert.equal(result.kind, 'config-error');
  assert.match(result.message, /--browser/);
  assert.equal(connections, 0);
});

// --- 显式端口 ---

test('显式端口与配置浏览器绑定，跳过其不可读文件且仅建立 TCP', async t => {
  const server = await fakeHttp(t);
  const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=~/${DIA}\r\nWEB_ACCESS_CDP_PORT=${server.port}\r\n` });
  const dir = await f.dataDir(DIA);
  const { result, connections, reads } = await f.run('select', { deniedPaths: { [path.join(dir, 'DevToolsActivePort')]: 'EPERM' } });
  assert.equal(result.kind, 'ok');
  assert.deepEqual(result.browser, { id: dir, label: 'Dia', host: '127.0.0.1', port: server.port, wsPath: null, endpointSource: 'config-port' });
  assert.deepEqual(reads, []);
  assert.equal(connections, 1);
  assert.equal(server.requests(), 0);
});

test('显式端口按身份绑定：配置旧值 chrome、override 写标准路径时仍使用该端口', async t => {
  const server = await fakeHttp(t);
  const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=chrome\nWEB_ACCESS_CDP_PORT=${server.port}\n` });
  const chrome = await f.dataDir(legacyPaths.darwin.chrome[0]);
  const { result } = await f.run('select', { override: `${chrome}/` });
  assert.equal(result.kind, 'ok');
  assert.equal(result.source, 'override');
  assert.equal(result.browser.endpointSource, 'config-port');
  assert.equal(result.browser.port, server.port);
});

test('override 其它浏览器只使用自己的端口文件，不借用显式端口', async t => {
  const chromeServer = await fakeHttp(t);
  const diaServer = await fakeHttp(t);
  const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=chrome\nWEB_ACCESS_CDP_PORT=${chromeServer.port}\n` });
  const dia = await f.dataDir(DIA, `${diaServer.port}\r\n/dia-own-endpoint\r\n`);
  const { result, connections } = await f.run('select', { override: dia });
  assert.equal(result.kind, 'ok');
  assert.equal(result.browser.port, diaServer.port);
  assert.equal(result.browser.wsPath, '/dia-own-endpoint');
  assert.equal(result.browser.endpointSource, undefined);
  assert.equal(connections, 1);
});

test('override 浏览器不可用时 unavailable，已配置的显式端口不成为兜底', async t => {
  const server = await fakeHttp(t);
  const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=chrome\nWEB_ACCESS_CDP_PORT=${server.port}\n` });
  await f.dataDir(DIA);
  const { result, connections } = await f.run('select', { override: `~/${DIA}` });
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.source, 'override');
  assert.equal(connections, 0);
  assert.equal(server.requests(), 0);
});

test('显式端口离线时不回退到同浏览器的可用文件端口', async t => {
  const fileServer = await fakeHttp(t);
  const offlinePort = await closedPort();
  const f = await fixture(t, { config: `WEB_ACCESS_BROWSER=~/${DIA}\nWEB_ACCESS_CDP_PORT=${offlinePort}\n` });
  await f.dataDir(DIA, `${fileServer.port}\n/file-endpoint\n`);
  const { result, connections, reads } = await f.run('select');
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.reason, 'offline');
  assert.equal(result.endpointSource, 'config-port');
  assert.deepEqual(reads, []);
  assert.equal(connections, 2);
});

test('显式端口缺 WEB_ACCESS_BROWSER 时返回配置错误，override 也不能补绑定', async t => {
  const f = await fixture(t, { config: 'WEB_ACCESS_CDP_PORT=9222\n' });
  const { result, connections } = await f.run('select', { override: 'chrome', rejectTcp: true });
  assert.equal(result.kind, 'config-error');
  assert.match(result.message, /一起配置/);
  assert.equal(connections, 0);
});

test('显式端口绑定的浏览器值无效时返回配置错误', async t => {
  const f = await fixture(t, { config: 'WEB_ACCESS_BROWSER=brave\nWEB_ACCESS_CDP_PORT=9222\n' });
  const { result, connections } = await f.run('select', { rejectTcp: true });
  assert.equal(result.kind, 'config-error');
  assert.match(result.message, /WEB_ACCESS_BROWSER 的值无效/);
  assert.equal(connections, 0);
});

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
  test(`真实配置模板的空值走首次配置，填入路径后使用该目录（设置浏览器=${configured}）`, async t => {
    let config = await fs.readFile(path.join(SCRIPTS, '..', 'templates', 'config.env.template'), 'utf8');
    if (configured) config = config.replace(/^WEB_ACCESS_BROWSER=$/m, `WEB_ACCESS_BROWSER=~/${DIA}`);
    const f = await fixture(t, { config });
    const server = await fakeHttp(t);
    await f.dataDir(DIA, `${server.port}\r\n/devtools/browser/fake\r\n`);
    const { result } = await f.run('select');
    assert.equal(result.kind, configured ? 'ok' : 'unset');
    if (configured) assert.equal(result.browser.port, server.port);
  });
}

test('checkPort 检测随机 HTTP 端口，仅建立 TCP，不发送 HTTP/CDP', async t => {
  const f = await fixture(t);
  const server = await fakeHttp(t);
  const { result, connections } = await f.run('checkPort', { port: server.port });
  assert.equal(result, true);
  assert.equal(connections, 1);
  assert.equal(server.requests(), 0);
});

// --- 提示文案 ---

test('不可用提示使用显示名与通用 inspect 地址，并注明 Edge 写法', async t => {
  const f = await fixture(t);
  const browser = { id: '/Users/u/Library/Application Support/Dia/User Data', label: 'Dia' };
  const notEnabled = (await f.run('explain', { result: { kind: 'unavailable', browser, source: 'preference', reason: 'not-enabled' } })).result.join('\n');
  assert.match(notEnabled, /默认偏好的浏览器 Dia（\/Users\/u\/Library\/Application Support\/Dia\/User Data）/);
  assert.match(notEnabled, /打开 Dia/);
  assert.ok(notEnabled.includes('chrome://inspect/#remote-debugging'));
  assert.ok(notEnabled.includes('edge://inspect/#remote-debugging'));
  assert.doesNotMatch(notEnabled, /dia:\/\/|\/Users\/u\/Library\/Application Support\/Dia\/User Data:\/\//);
  const offline = (await f.run('explain', { result: { kind: 'unavailable', browser, source: 'override', reason: 'offline', port: 1234 } })).result.join('\n');
  assert.match(offline, /本次指定的浏览器 Dia/);
  assert.match(offline, /端口 1234 未在监听/);
  const denied = (await f.run('explain', { result: { kind: 'unavailable', browser, source: 'preference', reason: 'unreadable', code: 'EPERM' } })).result.join('\n');
  assert.match(denied, /EPERM/);
  assert.match(denied, /WEB_ACCESS_CDP_PORT/);
});
