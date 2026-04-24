#!/usr/bin/env node
// 环境检查 + 确保 CDP Proxy 就绪（跨平台，替代 check-deps.mjs）

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_SCRIPT = path.join(ROOT, 'scripts', 'cdp-proxy.mjs');
const PROXY_PORT = Number(process.env.CDP_PROXY_PORT || 3456);
const ALLOWED_BROWSER_IDS = new Set(['chrome', 'chrome-canary', 'chromium', 'brave', 'edge', 'arc']);

function defaultDedicatedProfileDir(browserId) {
  return path.join(os.homedir(), '.web-access', `${browserId}-dedicated-profile`);
}

function parseArgs(argv) {
  const options = {
    browser: process.env.BROWSER_MODE || 'main',
    browserId: process.env.BROWSER_ID || process.env.BROWSER_APP || null,
    dedicatedProfileDir: process.env.DEDICATED_PROFILE_DIR || null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--browser') {
      options.browser = argv[index + 1] || options.browser;
      index += 1;
      continue;
    }
    if (arg === '--browser-id' || arg === '--browser-app') {
      options.browserId = argv[index + 1] || options.browserId;
      index += 1;
      continue;
    }
    if (arg === '--dedicated-profile-dir') {
      options.dedicatedProfileDir = argv[index + 1] || options.dedicatedProfileDir;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node check-deps.mjs [--browser main|dedicated] [--browser-id <id>] [--dedicated-profile-dir <path>]');
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!['main', 'primary', 'dedicated'].includes(options.browser)) {
    throw new Error(`Invalid browser mode: ${options.browser}`);
  }

  if (options.browser === 'primary') options.browser = 'main';

  if (options.browser === 'dedicated') {
    if (!options.browserId) {
      throw new Error('Dedicated mode requires --browser-id <chrome|chrome-canary|chromium|brave|edge|arc>');
    }
    if (!ALLOWED_BROWSER_IDS.has(options.browserId)) {
      throw new Error(`Invalid browser id: ${options.browserId}`);
    }
    options.dedicatedProfileDir = options.dedicatedProfileDir || defaultDedicatedProfileDir(options.browserId);
  }

  return options;
}

const OPTIONS = parseArgs(process.argv.slice(2));

// --- Node.js 版本检查 ---

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  const version = `v${process.versions.node}`;
  if (major >= 22) {
    console.log(`node: ok (${version})`);
  } else {
    console.log(`node: warn (${version}, 建议升级到 22+)`);
  }
}

// --- TCP 端口探测 ---

function checkPort(port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, host);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

// --- 浏览器调试端口检测（DevToolsActivePort 多路径 + 常见端口回退） ---

function activePortFiles() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || '';
  switch (os.platform()) {
    case 'darwin':
      return OPTIONS.browser === 'main'
        ? [
            path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
            path.join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort'),
            path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort'),
            path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/DevToolsActivePort'),
            path.join(home, 'Library/Application Support/Microsoft Edge/DevToolsActivePort'),
            path.join(home, 'Library/Application Support/Arc/User Data/DevToolsActivePort'),
          ]
        : [path.join(OPTIONS.dedicatedProfileDir, 'DevToolsActivePort')];
    case 'linux':
      return OPTIONS.browser === 'main'
        ? [
            path.join(home, '.config/google-chrome/DevToolsActivePort'),
            path.join(home, '.config/chromium/DevToolsActivePort'),
            path.join(home, '.config/BraveSoftware/Brave-Browser/DevToolsActivePort'),
            path.join(home, '.config/microsoft-edge/DevToolsActivePort'),
          ]
        : [path.join(OPTIONS.dedicatedProfileDir, 'DevToolsActivePort')];
    case 'win32':
      return OPTIONS.browser === 'main'
        ? [
            path.join(localAppData, 'Google/Chrome/User Data/DevToolsActivePort'),
            path.join(localAppData, 'Chromium/User Data/DevToolsActivePort'),
            path.join(localAppData, 'BraveSoftware/Brave-Browser/User Data/DevToolsActivePort'),
            path.join(localAppData, 'Microsoft/Edge/User Data/DevToolsActivePort'),
          ]
        : [path.join(OPTIONS.dedicatedProfileDir, 'DevToolsActivePort')];
    default:
      return [];
  }
}

async function detectChromePort() {
  // 优先从 DevToolsActivePort 文件读取
  for (const filePath of activePortFiles()) {
    try {
      const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      const port = parseInt(lines[0], 10);
      if (port > 0 && port < 65536 && await checkPort(port)) {
        return port;
      }
    } catch (_) {}
  }
  if (OPTIONS.browser === 'dedicated') {
    return null;
  }

  // 回退：探测常见端口
  for (const port of [9222, 9229, 9333]) {
    if (await checkPort(port)) {
      return port;
    }
  }
  return null;
}

// --- CDP Proxy 启动与等待 ---

function httpGetJson(url, timeoutMs = 3000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    .then(async (res) => {
      try { return JSON.parse(await res.text()); } catch { return null; }
    })
    .catch(() => null);
}

function startProxyDetached() {
  const logFile = path.join(os.tmpdir(), 'cdp-proxy.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    env: {
      ...process.env,
      BROWSER_MODE: OPTIONS.browser,
      BROWSER_ID: OPTIONS.browserId || '',
      DEDICATED_PROFILE_DIR: OPTIONS.dedicatedProfileDir || '',
    },
    detached: true,
    stdio: ['ignore', logFd, logFd],
    ...(os.platform() === 'win32' ? { windowsHide: true } : {}),
  });
  child.unref();
  fs.closeSync(logFd);
}

async function ensureProxy() {
  const healthUrl = `http://127.0.0.1:${PROXY_PORT}/health`;
  const shutdownUrl = `http://127.0.0.1:${PROXY_PORT}/shutdown`;
  const targetsUrl = `http://127.0.0.1:${PROXY_PORT}/targets`;

  const health = await httpGetJson(healthUrl);
  if (
    health?.status === 'ok' &&
    health.browserMode === OPTIONS.browser &&
    health.connected === true
  ) {
    console.log('proxy: ready');
    return true;
  }

  if (health?.status === 'ok' && health.browserMode && health.browserMode !== OPTIONS.browser) {
    console.log(`proxy: restarting from ${health.browserMode} to ${OPTIONS.browser}`);
    await httpGetJson(shutdownUrl, 2000);
    await new Promise((r) => setTimeout(r, 1000));
  }

  // /targets 返回 JSON 数组即 ready
  const targets = await httpGetJson(targetsUrl);
  if (Array.isArray(targets)) {
    console.log('proxy: ready');
    return true;
  }

  // 未运行或未连接，启动并等待
  console.log('proxy: connecting...');
  startProxyDetached();

  // 等 proxy 进程就绪
  await new Promise((r) => setTimeout(r, 2000));

  for (let i = 1; i <= 15; i++) {
    const result = await httpGetJson(targetsUrl, 8000);
    if (Array.isArray(result)) {
      console.log('proxy: ready');
      return true;
    }
    if (i === 1) {
      if (OPTIONS.browser === 'main') {
        console.log('⚠️  main browser 模式下，可能有远程调试授权弹窗，请点击「允许」后等待连接...');
      } else {
        console.log('⚠️  专用浏览器模式下通常不会有授权弹窗；若持续超时，请检查 dedicated profile 路径和启动参数是否一致。');
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('❌ 连接超时，请检查浏览器调试设置');
  console.log(`  日志：${path.join(os.tmpdir(), 'cdp-proxy.log')}`);
  return false;
}

// --- main ---

async function main() {
  checkNode();

  const chromePort = await detectChromePort();
  if (!chromePort) {
    if (OPTIONS.browser === 'main') {
      console.log('browser: not connected (main mode) — 请先让用户决定：开启当前 main browser 的远程调试，或明确切换到专用浏览器；不要自动改走专用浏览器路径。');
    } else {
      console.log('browser: not connected (dedicated mode)');
      console.log('请先启动专用浏览器，或检查 dedicated profile 路径是否正确：');
      console.log(`  browserId: ${OPTIONS.browserId}`);
      console.log(`  profile: ${OPTIONS.dedicatedProfileDir}`);
    }
    process.exit(1);
  }
  console.log(`browser: ok (port ${chromePort}, ${OPTIONS.browser} mode)`);

  const proxyOk = await ensureProxy();
  if (!proxyOk) {
    process.exit(1);
  }

  // 列出已有站点经验
  const patternsDir = path.join(ROOT, 'references', 'site-patterns');
  try {
    const sites = fs.readdirSync(patternsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
    if (sites.length) {
      console.log(`\nsite-patterns: ${sites.join(', ')}`);
    }
  } catch {}

}

await main();
