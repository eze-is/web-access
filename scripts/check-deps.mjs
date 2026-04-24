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
const ALLOWED_BROWSER_IDS = ['chrome', 'chrome-canary', 'chromium', 'brave', 'edge', 'arc'];
const ALLOWED_BROWSER_ID_SET = new Set(ALLOWED_BROWSER_IDS);

function log(message) {
  process.stderr.write(`${message}\n`);
}

function printJson(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function fail(result, exitCode = 1) {
  printJson({ ok: false, ...result });
  process.exit(exitCode);
}

function defaultDedicatedProfileDir(browserId) {
  return path.join(os.homedir(), '.web-access', `${browserId}-dedicated-profile`);
}

function parseArgs(argv) {
  const options = {
    browser: null,
    browserSpecified: false,
    browserId: process.env.BROWSER_ID || process.env.BROWSER_APP || null,
    dedicatedProfileDir: process.env.DEDICATED_PROFILE_DIR || null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--browser') {
      options.browser = argv[index + 1] || options.browser;
      options.browserSpecified = true;
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
      printJson({
        ok: true,
        help: true,
        usage: 'node check-deps.mjs [--browser main|dedicated] [--browser-id <id>] [--dedicated-profile-dir <path>]',
        defaultBehavior: 'auto-pick mode; dedicated preferred when both available',
      });
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.browserSpecified && !['main', 'dedicated'].includes(options.browser)) {
    throw new Error(`Invalid browser mode: ${options.browser}`);
  }

  if (options.browser === 'dedicated') {
    if (!options.browserId) {
      throw new Error('Dedicated mode requires --browser-id <chrome|chrome-canary|chromium|brave|edge|arc>');
    }
    if (!ALLOWED_BROWSER_ID_SET.has(options.browserId)) {
      throw new Error(`Invalid browser id: ${options.browserId}`);
    }
    options.dedicatedProfileDir = options.dedicatedProfileDir || defaultDedicatedProfileDir(options.browserId);
  }

  return options;
}

const OPTIONS = parseArgs(process.argv.slice(2));

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  const version = `v${process.versions.node}`;
  if (major >= 22) {
    log(`node: ok (${version})`);
  } else {
    log(`node: warn (${version}, 建议升级到 22+)`);
  }
  return {
    ok: major >= 22,
    version,
    recommendation: major >= 22 ? null : '建议升级到 22+',
  };
}

function checkPort(port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, host);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

function activePortFiles(browser, dedicatedProfileDir) {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || '';
  switch (os.platform()) {
    case 'darwin':
      return browser === 'main'
        ? [
            path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
            path.join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort'),
            path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort'),
            path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/DevToolsActivePort'),
            path.join(home, 'Library/Application Support/Microsoft Edge/DevToolsActivePort'),
            path.join(home, 'Library/Application Support/Arc/User Data/DevToolsActivePort'),
          ]
        : [path.join(dedicatedProfileDir, 'DevToolsActivePort')];
    case 'linux':
      return browser === 'main'
        ? [
            path.join(home, '.config/google-chrome/DevToolsActivePort'),
            path.join(home, '.config/chromium/DevToolsActivePort'),
            path.join(home, '.config/BraveSoftware/Brave-Browser/DevToolsActivePort'),
            path.join(home, '.config/microsoft-edge/DevToolsActivePort'),
          ]
        : [path.join(dedicatedProfileDir, 'DevToolsActivePort')];
    case 'win32':
      return browser === 'main'
        ? [
            path.join(localAppData, 'Google/Chrome/User Data/DevToolsActivePort'),
            path.join(localAppData, 'Chromium/User Data/DevToolsActivePort'),
            path.join(localAppData, 'BraveSoftware/Brave-Browser/User Data/DevToolsActivePort'),
            path.join(localAppData, 'Microsoft/Edge/User Data/DevToolsActivePort'),
          ]
        : [path.join(dedicatedProfileDir, 'DevToolsActivePort')];
    default:
      return [];
  }
}

async function detectChromePort(browser, dedicatedProfileDir = '') {
  for (const filePath of activePortFiles(browser, dedicatedProfileDir)) {
    try {
      const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      const port = parseInt(lines[0], 10);
      if (port > 0 && port < 65536 && await checkPort(port)) {
        return port;
      }
    } catch (_) {}
  }
  return null;
}

function httpGetJson(url, timeoutMs = 3000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    .then(async (res) => {
      try { return JSON.parse(await res.text()); } catch { return null; }
    })
    .catch(() => null);
}

function startProxyDetached(runtime) {
  const logFile = path.join(os.tmpdir(), 'cdp-proxy.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    env: {
      ...process.env,
      BROWSER_MODE: runtime.browser,
      BROWSER_ID: runtime.browserId || '',
      DEDICATED_PROFILE_DIR: runtime.dedicatedProfileDir || '',
    },
    detached: true,
    stdio: ['ignore', logFd, logFd],
    ...(os.platform() === 'win32' ? { windowsHide: true } : {}),
  });
  child.unref();
  fs.closeSync(logFd);
}

async function ensureProxy(runtime) {
  const healthUrl = `http://127.0.0.1:${PROXY_PORT}/health`;
  const shutdownUrl = `http://127.0.0.1:${PROXY_PORT}/shutdown`;
  const targetsUrl = `http://127.0.0.1:${PROXY_PORT}/targets`;

  const health = await httpGetJson(healthUrl);
  if (
    health?.status === 'ok' &&
    health.browserMode === runtime.browser &&
    health.connected === true
  ) {
    log('proxy: ready');
    return { ok: true, reusedExisting: true, restartedForModeSwitch: false };
  }

  let restartedForModeSwitch = false;
  if (health?.status === 'ok' && health.browserMode && health.browserMode !== runtime.browser) {
    log(`proxy: restarting from ${health.browserMode} to ${runtime.browser}`);
    await httpGetJson(shutdownUrl, 2000);
    await new Promise((r) => setTimeout(r, 1000));
    restartedForModeSwitch = true;
  }

  const targets = await httpGetJson(targetsUrl);
  if (Array.isArray(targets)) {
    log('proxy: ready');
    return { ok: true, reusedExisting: true, restartedForModeSwitch };
  }

  log('proxy: connecting...');
  startProxyDetached(runtime);

  await new Promise((r) => setTimeout(r, 2000));

  let hint = null;
  for (let i = 1; i <= 15; i++) {
    const result = await httpGetJson(targetsUrl, 8000);
    if (Array.isArray(result)) {
      log('proxy: ready');
      return { ok: true, reusedExisting: false, restartedForModeSwitch, hint };
    }
    if (i === 1) {
      hint = runtime.browser === 'main'
        ? 'main browser 模式下，可能有远程调试授权弹窗，请点击“允许”后等待连接'
        : '专用浏览器模式下通常不会有授权弹窗；若持续超时，请检查 dedicated profile 路径和启动参数是否一致';
      log(`warning: ${hint}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  log('proxy: timeout');
  return {
    ok: false,
    reusedExisting: false,
    restartedForModeSwitch,
    hint,
    reason: 'proxy_connect_timeout',
    logFile: path.join(os.tmpdir(), 'cdp-proxy.log'),
  };
}

function preferredDedicatedIds() {
  const preferred = [];
  if (OPTIONS.browserId && ALLOWED_BROWSER_ID_SET.has(OPTIONS.browserId)) {
    preferred.push(OPTIONS.browserId);
  }
  for (const id of ALLOWED_BROWSER_IDS) {
    if (!preferred.includes(id)) preferred.push(id);
  }
  return preferred;
}

async function detectFirstDedicatedAvailable() {
  for (const browserId of preferredDedicatedIds()) {
    const profile = defaultDedicatedProfileDir(browserId);
    const port = await detectChromePort('dedicated', profile);
    if (port) {
      return { browser: 'dedicated', browserId, dedicatedProfileDir: profile, port };
    }
  }
  return null;
}

async function resolveRuntime() {
  if (OPTIONS.browserSpecified) {
    if (OPTIONS.browser === 'main') {
      const port = await detectChromePort('main');
      if (!port) {
        log('browser: not connected (main mode)');
        return {
          ok: false,
          reason: 'main_not_connected',
          availableModes: [],
          requestedMode: 'main',
          guidance: '请先开启 main browser 的远程调试，或改为 dedicated 模式。',
        };
      }
      return {
        ok: true,
        browser: 'main',
        browserId: null,
        dedicatedProfileDir: null,
        port,
        availableModes: ['main'],
        selectedBecause: 'requested_mode',
      };
    }

    const dedicatedProfileDir = OPTIONS.dedicatedProfileDir || defaultDedicatedProfileDir(OPTIONS.browserId);
    const port = await detectChromePort('dedicated', dedicatedProfileDir);
    if (!port) {
      log('browser: not connected (dedicated mode)');
        return {
          ok: false,
          reason: 'dedicated_not_connected',
        availableModes: [],
        requestedMode: 'dedicated',
        browserId: OPTIONS.browserId,
        dedicatedProfileDir,
        guidance: '请先启动专用浏览器，或检查 dedicated profile 路径是否正确。',
      };
    }
    return {
      ok: true,
      browser: 'dedicated',
      browserId: OPTIONS.browserId,
      dedicatedProfileDir,
      port,
      availableModes: ['dedicated'],
      selectedBecause: 'requested_mode',
    };
  }

  const mainPort = await detectChromePort('main');
  const dedicated = await detectFirstDedicatedAvailable();
  const availableModes = [];
  if (mainPort) availableModes.push('main');
  if (dedicated) availableModes.push('dedicated');

  if (mainPort && dedicated) {
    log(`browser: both available (main + dedicated:${dedicated.browserId}) -> selected dedicated`);
    return {
      ok: true,
      ...dedicated,
      availableModes,
      selectedBecause: 'dedicated_preferred_when_both_available',
    };
  }
  if (dedicated) {
    log(`browser: dedicated available (${dedicated.browserId}) -> selected dedicated`);
    return {
      ok: true,
      ...dedicated,
      availableModes,
      selectedBecause: 'only_dedicated_available',
    };
  }
  if (mainPort) {
    log('browser: only main available -> selected main');
    return {
      ok: true,
      browser: 'main',
      browserId: null,
      dedicatedProfileDir: null,
      port: mainPort,
      availableModes,
      selectedBecause: 'only_main_available',
    };
  }

  log('browser: none available');
  return {
    ok: false,
    reason: 'no_browser_available',
    availableModes,
    guidance: {
      main: '先在主力浏览器开启 remote debugging，然后重跑 check-deps。',
      dedicated: '先启动 dedicated profile（带 --remote-debugging-port），再重跑 check-deps。',
    },
  };
}

async function main() {
  const node = checkNode();

  const runtime = await resolveRuntime();
  if (!runtime.ok) {
    fail({
      node,
      proxyReady: false,
      ...runtime,
    });
  }

  log(`browser: ok (port ${runtime.port}, ${runtime.browser} mode${runtime.browserId ? `, ${runtime.browserId}` : ''})`);
  const proxy = await ensureProxy(runtime);
  if (!proxy.ok) {
    fail({
      node,
      selectedMode: runtime.browser,
      browserId: runtime.browserId,
      dedicatedProfileDir: runtime.dedicatedProfileDir,
      port: runtime.port,
      availableModes: runtime.availableModes,
      selectedBecause: runtime.selectedBecause,
      proxyReady: false,
      proxy,
    });
  }

  const patternsDir = path.join(ROOT, 'references', 'site-patterns');
  let sitePatterns = [];
  try {
    sitePatterns = fs.readdirSync(patternsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
    if (sitePatterns.length) {
      log(`site-patterns: ${sitePatterns.join(', ')}`);
    }
  } catch {}

  printJson({
    ok: true,
    node,
    availableModes: runtime.availableModes,
    selectedMode: runtime.browser,
    selectedBecause: runtime.selectedBecause,
    browserId: runtime.browserId,
    dedicatedProfileDir: runtime.dedicatedProfileDir,
    port: runtime.port,
    proxyReady: true,
    proxy,
    sitePatterns,
  });
}

try {
  await main();
} catch (error) {
  fail({
    reason: 'unexpected_error',
    message: error instanceof Error ? error.message : String(error),
    proxyReady: false,
  });
}
