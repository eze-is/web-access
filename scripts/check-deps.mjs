#!/usr/bin/env node
// 环境检查 + 确保 CDP Proxy 就绪
//
// 用法：
//   node check-deps.mjs                  默认行为：读 config.env 偏好
//   node check-deps.mjs --browser edge   本次临时指定浏览器（不写 config.env）
//
// 持久偏好 → config.env (skill 根目录, gitignored)
// 单次覆盖 → --browser 命令行参数（全链路 argv，不碰 process.env）

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectBrowser, knownBrowsers, findFallbackPort } from './browser-discovery.mjs';
import { waitForProxyConnection } from './check-deps-helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_SCRIPT = path.join(ROOT, 'scripts', 'cdp-proxy.mjs');
const PROXY_PORT = Number(process.env.CDP_PROXY_PORT || 3456);
const CONFIG_PATH = path.join(ROOT, 'config.env');
const CONFIG_TEMPLATE = path.join(ROOT, 'templates', 'config.env.template');

// --- 参数解析 ---

function parseArgs(argv) {
  const opts = { browser: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--browser' && argv[i + 1]) { opts.browser = argv[i + 1]; i++; }
    else if (argv[i].startsWith('--browser=')) { opts.browser = argv[i].slice('--browser='.length); }
  }
  return opts;
}

// --- 首次安装：从模板创建 config.env ---

function ensureConfigExists() {
  if (fs.existsSync(CONFIG_PATH)) return;
  try {
    fs.copyFileSync(CONFIG_TEMPLATE, CONFIG_PATH);
    console.log(`config: 已从模板创建 ${CONFIG_PATH}`);
  } catch {
    // 模板不存在或拷贝失败 —— 不阻塞，readConfig 会兜底
  }
}

// --- Node.js 版本检查 ---

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  const version = `v${process.versions.node}`;
  if (major >= 22) console.log(`node: ok (${version})`);
  else console.log(`node: warn (${version}, 建议升级到 22+)`);
}

// --- CDP Proxy 启动与等待 ---

function httpGetJson(url, timeoutMs = 3000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    .then(async (res) => { try { return JSON.parse(await res.text()); } catch { return null; } })
    .catch(() => null);
}

function startProxyDetached(browserOverride) {
  const logFile = path.join(os.tmpdir(), 'cdp-proxy.log');
  const logFd = fs.openSync(logFile, 'a');
  const args = [PROXY_SCRIPT];
  if (browserOverride) args.push('--browser', browserOverride);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    ...(os.platform() === 'win32' ? { windowsHide: true } : {}),
  });
  child.unref();
  fs.closeSync(logFd);
}

async function ensureProxy(expectedBrowserId, browserOverride) {
  const healthUrl = `http://127.0.0.1:${PROXY_PORT}/health`;

  // 复用：proxy 已运行 + 已连接浏览器 → 校验 expected vs actual
  const health = await httpGetJson(healthUrl);
  if (health?.status === 'ok' && health.connected) {
    const runningId = health.browser?.id;
    const runningLabel = health.browser?.label || runningId || 'unknown';
    if (expectedBrowserId && runningId && runningId !== 'unknown' && runningId !== expectedBrowserId) {
      console.log(`proxy: 浏览器不一致 — 当前已连着 ${runningLabel}，但本次需要 ${expectedBrowserId}`);
      console.log('  请在终端运行 pkill -f cdp-proxy.mjs 重置后再试');
      return false;
    }
    console.log(`proxy: ready (${runningLabel})`);
    return true;
  }

  console.log('proxy: connecting...');
  startProxyDetached(browserOverride);

  await new Promise((r) => setTimeout(r, 2000));

  console.log('⚠️  浏览器可能有授权弹窗，请点击「允许」后等待连接...');
  const ready = await waitForProxyConnection({
    healthUrl,
    httpGetJson,
  });
  if (ready) {
    const newHealth = await httpGetJson(healthUrl);
    const label = newHealth?.browser?.label || 'unknown';
    console.log(`proxy: ready (${label})`);
    return true;
  }

  console.log('❌ 连接超时，请检查浏览器调试设置');
  console.log(`  日志：${path.join(os.tmpdir(), 'cdp-proxy.log')}`);
  return false;
}

// --- 输出浏览器选择结果，返回是否可以继续启动 proxy ---

function printAvailableHint(detected) {
  const detectedIds = new Set(detected.map(b => b.id));
  const configurable = knownBrowsers().filter(b => !detectedIds.has(b.id));
  if (detected.length) {
    console.log(`  已开启远程调试：${detected.map(b => `${b.label} (${b.id}, port ${b.port})`).join('、')}`);
  }
  if (configurable.length) {
    console.log(`  其他可配置：${configurable.map(b => `${b.label} (${b.id})`).join('、')}`);
  }
}

async function resolveAndReport(override) {
  const result = await selectBrowser(override);

  switch (result.kind) {
    case 'ok': {
      const sourceTag = result.source === 'override' ? '[--browser 指定]' : '[config.env 偏好]';
      console.log(`browser: ok (${result.browser.label}, port ${result.browser.port}) ${sourceTag}`);
      return { proceed: true, browserId: result.browser.id };
    }

    case 'ambiguous': {
      console.log('browser: needs decision — 用户尚未在 config.env 设置偏好');
      printAvailableHint(result.detected);
      console.log('  请询问用户：哪个浏览器作为 Agent 的默认？（写入 config.env 的 WEB_ACCESS_BROWSER）');
      console.log('  若仅本次使用，可重跑：node check-deps.mjs --browser <id>');
      return { proceed: false, exitCode: 2 };
    }

    case 'mismatch': {
      const expected = result.override || result.configured;
      const expectedLabel = knownBrowsers().find(b => b.id === expected)?.label || expected;
      const sourceDesc = result.source === 'override' ? '本次指定' : '默认偏好';
      console.log(`browser: error — ${sourceDesc}的浏览器是 "${expected}" (${expectedLabel})，但没连上`);
      console.log(`  Agent 处理顺序：`);
      console.log(`    1. 先用系统命令打开 ${expectedLabel}（按你所在平台自行选择，如 macOS 的 open -a），再重新运行 node check-deps.mjs`);
      console.log(`    2. 若仍报相同错误，可能是因为远程调试开关没启用 —— 告诉用户：在 ${expectedLabel} 的地址栏访问 ${expected}://inspect/#remote-debugging，勾选 "Allow remote debugging for this browser instance"`);
      printAvailableHint(result.detected);
      if (result.source === 'preference') {
        console.log(`  也可以编辑 config.env 改默认偏好，或本次临时换浏览器：node check-deps.mjs --browser <id>`);
      }
      return { proceed: false, exitCode: 1 };
    }

    case 'empty': {
      // 末路兜底：尝试常见固定端口（用户手动 --remote-debugging-port=9222 启动的场景）
      const fallbackPort = await findFallbackPort();
      if (fallbackPort) {
        console.log(`browser: ok (port ${fallbackPort}) [通过手动调试端口连接]`);
        return { proceed: true };
      }
      console.log('browser: 未连接 — 没有任何浏览器打开远程调试开关');
      console.log(`  支持的浏览器：${knownBrowsers().map(b => b.label).join('、')}`);
      console.log('  在你想用的浏览器地址栏打开 chrome://inspect/#remote-debugging 或 edge://inspect/#remote-debugging，勾选 "Allow remote debugging for this browser instance"');
      return { proceed: false, exitCode: 1 };
    }
  }
}

// --- main ---

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  ensureConfigExists();
  checkNode();

  const { proceed, exitCode, browserId } = await resolveAndReport(opts.browser);
  if (!proceed) process.exit(exitCode);

  const proxyOk = await ensureProxy(browserId, opts.browser);
  if (!proxyOk) process.exit(1);

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
