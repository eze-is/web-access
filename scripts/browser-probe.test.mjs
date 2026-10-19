import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

// 平台与 HOME 在子进程内模拟；应用数据目录、浏览器数据目录都是临时树，端口为随机本机端口。
// 子进程记录目录列举、文件读取与 TCP 连接，用来证明「只列根目录本身」「不读浏览器数据内容」「只做 TCP」。
const PRELOAD = `
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
const opts = JSON.parse(process.env.TEST_OPTS);
os.platform = () => opts.platform;
os.homedir = () => opts.home;
const record = { connections: 0, reads: [], readdirs: [] };
const originalConnect = net.createConnection;
net.createConnection = (...args) => { record.connections++; return originalConnect(...args); };
const originalRead = fs.readFileSync;
fs.readFileSync = (file, ...args) => { record.reads.push(String(file)); return originalRead(file, ...args); };
const originalReaddir = fs.readdirSync;
fs.readdirSync = (dir, ...args) => { record.readdirs.push(String(dir)); return originalReaddir(dir, ...args); };
const originalWrite = fs.writeFileSync;
process.on('exit', () => originalWrite(process.env.TEST_RECORD, JSON.stringify(record)));
`;
const RUNNER = `
const opts = JSON.parse(process.env.TEST_OPTS);
const probe = await import(new URL('./scripts/browser-probe.mjs', import.meta.url));
let result;
if (opts.action === 'roots') result = probe.appDataRoots();
else if (opts.action === 'list') result = probe.listTopFolders(opts.root);
else if (opts.action === 'listRoots') result = probe.listAppDataRoots();
else if (opts.action === 'resolve') result = probe.resolveFolder(opts.folder);
else result = await probe.probeFolder(opts.folder);
console.log(JSON.stringify(result));
`;

async function fixture(t, { platform = 'darwin' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-access-probe-'));
  const scripts = path.join(root, 'scripts');
  const home = path.join(root, 'home dir');
  const localAppData = path.join(root, 'AppData', 'Local');
  const appData = path.join(root, 'AppData', 'Roaming');
  await fs.mkdir(scripts, { recursive: true });
  for (const name of ['browser-probe.mjs', 'browser-discovery.mjs', 'user-data.mjs']) {
    await fs.copyFile(path.join(SCRIPTS, name), path.join(scripts, name));
  }
  await fs.writeFile(path.join(root, 'preload.mjs'), PRELOAD);
  await fs.writeFile(path.join(root, 'runner.mjs'), RUNNER);
  const appRoot = { darwin: path.join(home, 'Library', 'Application Support'), linux: path.join(home, '.config'), win32: localAppData }[platform];
  for (const dir of [home, appRoot, localAppData, appData].filter(Boolean)) await fs.mkdir(dir, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const exec = async (args, options = {}) => {
    const recordPath = path.join(root, `record-${Math.random().toString(36).slice(2)}.json`);
    const child = spawn(process.execPath, ['--import', path.join(root, 'preload.mjs'), ...args], {
      env: {
        ...process.env, TEST_OPTS: JSON.stringify({ platform, home, ...options }), TEST_RECORD: recordPath,
        LOCALAPPDATA: localAppData, APPDATA: appData,
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
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
      return { code, stdout, stderr, ...record };
    } finally { clearTimeout(watchdog); }
  };
  return {
    root, home, appRoot, localAppData, appData,
    async call(action, options = {}) {
      const outcome = await exec([path.join(root, 'runner.mjs')], { action, ...options });
      assert.equal(outcome.code, 0, `${outcome.stdout}\n${outcome.stderr}`);
      return { ...outcome, result: JSON.parse(outcome.stdout.trim()) };
    },
    exec,
    cli: (...args) => exec([path.join(scripts, 'browser-probe.mjs'), ...args]),
    // 建浏览器数据目录：Local State + 可选 DevToolsActivePort + 一个 profile 子目录（探测不应进入）
    async browser(base, relative, portFile = null) {
      const dir = path.join(base, relative);
      await fs.mkdir(path.join(dir, 'Default'), { recursive: true });
      await fs.writeFile(path.join(dir, 'Local State'), '{"secret":"不应被读取"}');
      await fs.writeFile(path.join(dir, 'Default', 'Preferences'), '{}');
      if (portFile !== null) await fs.writeFile(path.join(dir, 'DevToolsActivePort'), portFile);
      return dir;
    },
  };
}

async function fakeHttp(t, host = '127.0.0.1') {
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.end('{}'); });
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

test('应用数据根目录：macOS Application Support、Linux ~/.config / ~/snap / ~/.var/app、Windows LOCALAPPDATA 与 APPDATA', async t => {
  for (const platform of ['darwin', 'linux', 'win32', 'unsupported-os']) {
    const f = await fixture(t, { platform });
    const { result } = await f.call('roots');
    const expected = {
      darwin: [path.join(f.home, 'Library', 'Application Support')],
      linux: [path.join(f.home, '.config'), path.join(f.home, 'snap'), path.join(f.home, '.var', 'app')],
      win32: [f.localAppData, f.appData],
      'unsupported-os': [],
    }[platform];
    assert.deepEqual(result, expected, platform);
  }
});

test('列根目录只读根目录本身：只给文件夹名，不进入任何文件夹，不读文件不发 TCP', async t => {
  const f = await fixture(t);
  const server = await fakeHttp(t);
  await f.browser(f.appRoot, 'Google/Chrome', `${server.port}\n/x\n`);
  await f.browser(f.appRoot, 'Dia/User Data');
  await fs.writeFile(path.join(f.appRoot, 'notes.txt'), 'file');
  const { result, readdirs, reads, connections } = await f.call('list', { root: f.appRoot });
  assert.deepEqual(result, { root: f.appRoot, folders: ['Dia', 'Google'] });
  assert.deepEqual(readdirs, [f.appRoot]);
  assert.ok(!reads.some(file => file.startsWith(f.appRoot)), reads.join('\n'));
  assert.equal(connections, 0);
  assert.equal(server.requests(), 0);
});

test('根目录不可列出时报告错误码，不抛出', async t => {
  const f = await fixture(t);
  const missing = path.join(f.root, 'missing');
  const { result } = await f.call('list', { root: missing });
  assert.deepEqual(result, { root: missing, code: 'ENOENT' });
});

test('探测 Dia：识别 User Data，报告远程调试已开启；不进入 profile、只读端口文件、只发 TCP', async t => {
  const f = await fixture(t);
  const server = await fakeHttp(t);
  const dia = await f.browser(f.appRoot, 'Dia/User Data', `${server.port}\r\n/devtools/browser/dia\r\n`);
  const folder = path.join(f.appRoot, 'Dia');
  const { result, readdirs, reads, connections } = await f.call('probe', { folder });
  assert.deepEqual(result, {
    folder, skipped: [], truncated: false,
    browsers: [{ dataDir: dia, name: 'Dia', remoteDebugging: { enabled: true, port: server.port } }],
  });
  assert.deepEqual(readdirs, [folder]);
  assert.deepEqual(reads.filter(file => file.startsWith(f.appRoot)), [path.join(dia, 'DevToolsActivePort')]);
  assert.equal(connections, 1);
  assert.equal(server.requests(), 0);
});

test('首次配置识别 IPv6-only 调试端口，不发送 HTTP/CDP、不读取 profile', async t => {
  const server = await fakeHttp(t, '::1');
  if (!server) return;
  const f = await fixture(t);
  const browser = await f.browser(f.appRoot, 'Dia/User Data', `${server.port}\n/devtools/browser/ipv6\n`);
  const folder = path.join(f.appRoot, 'Dia');
  const { result, readdirs, reads, connections } = await f.call('probe', { folder });
  assert.deepEqual(result, {
    folder, skipped: [], truncated: false,
    browsers: [{ dataDir: browser, name: 'Dia', remoteDebugging: { enabled: true, port: server.port } }],
  });
  assert.equal(connections, 2);
  assert.deepEqual(readdirs, [folder]);
  assert.deepEqual(reads.filter(file => file.startsWith(f.appRoot)), [path.join(browser, 'DevToolsActivePort')]);
  assert.equal(server.requests(), 0);
});

test('探测 Google：同一文件夹下的多个浏览器分别报告未开启原因，非浏览器子目录不误报', async t => {
  const f = await fixture(t);
  const stale = await closedPort();
  const chrome = await f.browser(f.appRoot, 'Google/Chrome', `${stale}\n/stale\n`);
  const canary = await f.browser(f.appRoot, 'Google/Chrome Canary');
  await fs.mkdir(path.join(f.appRoot, 'Google', 'GoogleUpdater', 'crx_cache'), { recursive: true });
  const { result, connections } = await f.call('probe', { folder: path.join(f.appRoot, 'Google') });
  const byName = Object.fromEntries(result.browsers.map(browser => [browser.name, browser]));
  assert.deepEqual(Object.keys(byName).sort(), ['Chrome', 'Chrome Canary']);
  assert.equal(byName.Chrome.dataDir, chrome);
  assert.equal(byName.Chrome.remoteDebugging.enabled, false);
  assert.match(byName.Chrome.remoteDebugging.detail, new RegExp(`端口 ${stale} 未在监听`));
  assert.equal(byName['Chrome Canary'].dataDir, canary);
  assert.match(byName['Chrome Canary'].remoteDebugging.detail, /没有 DevToolsActivePort/);
  assert.equal(connections, 2);
});

test('探测深度有界：第 3 层能找到，第 4 层不再深入', async t => {
  const f = await fixture(t);
  const vendor = path.join(f.appRoot, 'Vendor');
  const shallow = await f.browser(vendor, 'a/b/Shallow');
  await f.browser(vendor, 'c/d/e/Deep');
  const { result, readdirs } = await f.call('probe', { folder: vendor });
  assert.deepEqual(result.browsers.map(browser => browser.dataDir), [shallow]);
  assert.ok(!readdirs.some(dir => dir.endsWith(path.join('c', 'd', 'e'))), readdirs.join('\n'));
});

test('文件夹参数：在应用数据根目录下查找，支持多级相对路径与根目录内的绝对路径', async t => {
  const f = await fixture(t);
  const dia = await f.browser(f.appRoot, 'Dia/User Data');
  assert.deepEqual((await f.call('resolve', { folder: 'Dia' })).result, [path.join(f.appRoot, 'Dia')]);
  assert.deepEqual((await f.call('resolve', { folder: 'Dia/User Data/' })).result, [dia]);
  assert.deepEqual((await f.call('resolve', { folder: 'NotInstalled' })).result, []);
  assert.deepEqual((await f.call('resolve', { folder: path.join(f.appRoot, 'Dia') })).result, [path.join(f.appRoot, 'Dia')]);
  const { result } = await f.call('probe', { folder: dia });
  assert.deepEqual(result.browsers.map(browser => browser.dataDir), [dia]);
});

test('探测范围由代码限定：拒绝 ~、.. 越界、根目录本身、根目录外的绝对路径与软链接逃逸，且不列举任何目录', async t => {
  const f = await fixture(t);
  await f.browser(path.join(f.home, 'Documents'), 'proj/fakebrowser');
  await fs.symlink(path.join(f.home, 'Documents'), path.join(f.appRoot, 'LinkOut'));
  const cases = [
    ['~', /不接受 ~/],
    ['~/Documents', /不接受 ~/],
    ['..', /根目录本身或其外部/],
    ['../..', /根目录本身或其外部/],
    ['Dia/../../..', /根目录本身或其外部/],
    ['.', /根目录本身或其外部/],
    ['', /参数为空/],
    [path.join(f.home, 'Documents'), /不在应用数据根目录之内/],
    [f.appRoot, /不在应用数据根目录之内/],
    ['LinkOut', /软链接指向应用数据根目录之外/],
  ];
  for (const [folder, pattern] of cases) {
    const outcome = await f.exec([path.join(f.root, 'runner.mjs')], { action: 'resolve', folder });
    assert.notEqual(outcome.code, 0, folder);
    assert.match(outcome.stderr, pattern, folder);
    assert.deepEqual(outcome.readdirs, [], folder);
  }
  const cli = await f.cli('..', '~', 'LinkOut');
  assert.equal(cli.code, 1, cli.stdout + cli.stderr);
  assert.equal((cli.stdout.match(/参数无效/g) || []).length, 3, cli.stdout);
  assert.doesNotMatch(cli.stdout, /fakebrowser/);
  assert.deepEqual(cli.readdirs, []);
});

test('Windows 文件夹名同时在 LOCALAPPDATA 与 APPDATA 下查找（Opera 位于 Roaming），多级路径从该处起限深', async t => {
  const f = await fixture(t, { platform: 'win32' });
  await fs.mkdir(path.join(f.appData, 'Opera Software'), { recursive: true });
  const { result } = await f.call('resolve', { folder: 'Opera Software' });
  assert.deepEqual(result, [path.join(f.appData, 'Opera Software')]);
  const arcPackage = path.join(f.localAppData, 'Packages', 'TheBrowserCompany.Arc_ttt1ap7aakyb4');
  const arc = await f.browser(arcPackage, 'LocalCache/Local/Arc/User Data');
  const cli = await f.cli(path.join('Packages', 'TheBrowserCompany.Arc_ttt1ap7aakyb4', 'LocalCache'));
  assert.equal(cli.code, 0, cli.stdout + cli.stderr);
  assert.ok(cli.stdout.includes(`- Arc：${arc}`), cli.stdout);
});

test('命令行输出数据目录、调试状态与可直接写入的配置行，退出码区分是否找到', async t => {
  const f = await fixture(t);
  const server = await fakeHttp(t);
  const dia = await f.browser(f.appRoot, 'Dia/User Data', `${server.port}\n/devtools/browser/dia\n`);
  const brave = await f.browser(f.appRoot, 'BraveSoftware/Brave-Browser');
  const found = await f.cli('Dia', 'BraveSoftware');
  assert.equal(found.code, 0, found.stdout + found.stderr);
  assert.ok(found.stdout.includes(`- Dia：${dia}`), found.stdout);
  assert.match(found.stdout, new RegExp(`远程调试：已开启（端口 ${server.port} 在监听）`));
  assert.ok(found.stdout.includes(`WEB_ACCESS_BROWSER=${dia}`), found.stdout);
  assert.ok(found.stdout.includes(`- Brave-Browser：${brave}`), found.stdout);
  assert.ok(found.stdout.includes('chrome://inspect/#remote-debugging'), found.stdout);
  assert.ok(found.stdout.includes('edge://inspect/#remote-debugging'), found.stdout);
  assert.equal(server.requests(), 0);

  await fs.mkdir(path.join(f.appRoot, 'Slack'), { recursive: true });
  const none = await f.cli('Slack', 'NotInstalled');
  assert.equal(none.code, 1);
  assert.match(none.stdout, /未找到 Chromium 浏览器数据目录/);
  assert.match(none.stdout, /应用数据根目录下没有这个文件夹/);
  assert.equal((await f.cli()).code, 2);
});

// 权限拒绝只能在非 root 的 POSIX 上用 chmod 构造
const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0;

test('无权限的子文件夹只跳过并注明，同一文件夹里其他可读的浏览器照常报告', { skip: !canChmod && '需要非 root 的 POSIX' }, async t => {
  const f = await fixture(t);
  const server = await fakeHttp(t);
  const vendor = path.join(f.appRoot, 'Vendor');
  const browser = await f.browser(vendor, 'Browser/User Data', `${server.port}\n/x\n`);
  const locked = path.join(vendor, 'Locked');
  await fs.mkdir(locked);
  await fs.chmod(locked, 0o000);
  let result;
  let cli;
  // 在测试体内恢复权限，保证临时目录能被清理
  try {
    ({ result } = await f.call('probe', { folder: vendor }));
    cli = await f.cli('Vendor');
  } finally { await fs.chmod(locked, 0o755); }
  assert.deepEqual(result.browsers.map(item => item.dataDir), [browser]);
  assert.equal(result.browsers[0].remoteDebugging.enabled, true);
  assert.deepEqual(result.skipped, [{ dir: locked, code: 'EACCES' }]);
  assert.equal(cli.code, 0, cli.stdout + cli.stderr);
  assert.ok(cli.stdout.includes(`无法读取，已跳过（EACCES）：${locked}`), cli.stdout);
  assert.ok(cli.stdout.includes(`WEB_ACCESS_BROWSER=${browser}`), cli.stdout);
  assert.equal(cli.stderr, '');
});

test('被探测的文件夹本身无权限时报告无法读取，不崩溃', { skip: !canChmod && '需要非 root 的 POSIX' }, async t => {
  const f = await fixture(t);
  const locked = path.join(f.appRoot, 'Locked');
  await f.browser(locked, 'User Data');
  await fs.chmod(locked, 0o000);
  let cli;
  try { cli = await f.cli('Locked'); }
  finally { await fs.chmod(locked, 0o755); }
  assert.equal(cli.code, 1, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /无法读取该文件夹（EACCES），已跳过/);
  assert.equal(cli.stderr, '');
});

test('Linux：snap 与 flatpak 的浏览器可按文件夹名探测，首次配置只列存在的根目录', async t => {
  const f = await fixture(t, { platform: 'linux' });
  const snap = path.join(f.home, 'snap');
  const flatpak = path.join(f.home, '.var', 'app');
  const chromium = await f.browser(snap, 'chromium/common/chromium');
  const chrome = await f.browser(flatpak, 'com.google.Chrome/config/google-chrome');
  await f.browser(f.appRoot, 'BraveSoftware/Brave-Browser');
  const listed = (await f.call('listRoots')).result;
  assert.deepEqual(listed, [
    { root: f.appRoot, folders: ['BraveSoftware'] },
    { root: snap, folders: ['chromium'] },
    { root: flatpak, folders: ['com.google.Chrome'] },
  ]);
  const cli = await f.cli('chromium', 'com.google.Chrome');
  assert.equal(cli.code, 0, cli.stdout + cli.stderr);
  assert.ok(cli.stdout.includes(`- chromium：${chromium}`), cli.stdout);
  assert.ok(cli.stdout.includes(`- google-chrome：${chrome}`), cli.stdout);
  // 只有 ~/.config 时其余两个根目录不出现在列表里
  await fs.rm(snap, { recursive: true });
  await fs.rm(path.join(f.home, '.var'), { recursive: true });
  assert.deepEqual((await f.call('listRoots')).result, [{ root: f.appRoot, folders: ['BraveSoftware'] }]);
});

// 审查 F7：snap 的 ~/snap/<名>/current 是指向同根目录内修订目录的软链接，应当允许；只有指出根目录才拒绝。
// 经 current 探测时，输出的数据目录保留 current 写法，snap 升级换修订号后配置仍然有效。
test('Linux snap：经同根目录内的 current 软链接探测被允许，输出保留 current 路径；指出根目录的软链接仍被拒绝', async t => {
  const f = await fixture(t, { platform: 'linux' });
  const snap = path.join(f.home, 'snap');
  await f.browser(snap, 'brave/123/.config/BraveSoftware/Brave-Browser');
  await fs.symlink('123', path.join(snap, 'brave', 'current'));
  await fs.mkdir(path.join(f.home, 'Documents'), { recursive: true });
  await fs.symlink(path.join(f.home, 'Documents'), path.join(snap, 'evil'));

  const viaCurrent = await f.cli('brave/current/.config');
  assert.equal(viaCurrent.code, 0, viaCurrent.stdout + viaCurrent.stderr);
  const expected = path.join(snap, 'brave', 'current', '.config', 'BraveSoftware', 'Brave-Browser');
  assert.ok(viaCurrent.stdout.includes(`WEB_ACCESS_BROWSER=${expected}`), viaCurrent.stdout);

  // 从应用文件夹本身探测：数据目录在第 4 层（<修订号>/.config/BraveSoftware/Brave-Browser），超出深度上限，且不经过 current 软链接
  const fromApp = await f.cli('brave');
  assert.equal(fromApp.code, 1, fromApp.stdout);
  assert.match(fromApp.stdout, /未找到 Chromium 浏览器数据目录/);

  const escaped = await f.cli('evil');
  assert.equal(escaped.code, 1);
  assert.match(escaped.stdout, /软链接指向应用数据根目录之外/);
});
