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
import { selectBrowser, knownBrowsers, findFallbackPort, getConfiguredBrowserId } from './browser-discovery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_SCRIPT = path.join(ROOT, 'scripts', 'cdp-proxy.mjs');
const PROXY_PORT = Number(process.env.CDP_PROXY_PORT || 3456);
const HEALTH_URL = `http://127.0.0.1:${PROXY_PORT}/health`;
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
    .then(async (res) => { if (!res.ok) return null; try { return JSON.parse(await res.text()); } catch { return null; } })
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

function matchesBrowser(health, expectedBrowserId) {
  const runningId = health.browser?.id;
  const runningLabel = health.browser?.label || runningId || 'unknown';
  if (expectedBrowserId && (!runningId || runningId === 'unknown') && health.connected === true) {
    console.log(`proxy: 无法确认当前连接的浏览器是否为 ${expectedBrowserId}，保留已有实例`);
    return false;
  }
  if (expectedBrowserId && runningId && runningId !== 'unknown' && runningId !== expectedBrowserId) {
    console.log(`proxy: 浏览器不一致 — 当前实例使用 ${runningLabel}，但本次需要 ${expectedBrowserId}`);
    console.log('  如需切换浏览器，请等共享任务完成，运行 node scripts/proxy-maintenance.mjs stop 后再指定 --browser');
    return false;
  }
  return true;
}

async function ensureProxy(expectedBrowserId, browserOverride, health) {
  const targetsUrl = `http://127.0.0.1:${PROXY_PORT}/targets`;

  // 已有服务由自身维护连接；断线不意味着进程退出。
  if (health?.status === 'ok') {
    if (health.maintenance) {
      console.log('proxy: 共享服务正在维护，请等待维护完成后重试；保留已有实例');
      return false;
    }
    if (!matchesBrowser(health, expectedBrowserId)) return false;
    if (health.connected === true) {
      const label = health.browser?.label || health.browser?.id || 'unknown';
      console.log(`proxy: ready (${label}) [复用已有实例]`);
      return true;
    }
    console.log('proxy: reconnecting... [复用已有实例]');
  } else {
    console.log('proxy: connecting...');
    startProxyDetached(browserOverride);
    await new Promise((r) => setTimeout(r, 2000));
  }

  for (let i = 1; i <= 15; i++) {
    const result = await httpGetJson(targetsUrl, 8000);
    if (Array.isArray(result)) {
      const newHealth = await httpGetJson(HEALTH_URL);
      if (newHealth?.status === 'ok') {
        if (newHealth.maintenance) {
          console.log('proxy: 共享服务正在维护，请等待维护完成后重试；保留已有实例');
          return false;
        }
        if (!matchesBrowser(newHealth, expectedBrowserId)) return false;
        if (newHealth.connected === true) {
          const label = newHealth.browser?.label || newHealth.browser?.id || 'unknown';
          console.log(`proxy: ready (${label})`);
          return true;
        }
      }
    }
    if (i === 1) {
      console.log('⚠️  浏览器可能有授权弹窗，请点击「允许」后等待连接...');
    }
    await new Promise((r) => setTimeout(r, 1000));
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
    case 'config-error': {
      console.log(`browser: 配置错误 — ${result.message}`);
      return { proceed: false, exitCode: 1 };
    }
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
      const denied = result.inaccessible?.find(b => b.id === expected);
      if (denied) {
        console.log(`browser: 文件访问受限 — 无法读取 ${expectedLabel} 的调试端口文件（${denied.code}）`);
        console.log(`  路径：${denied.devToolsPath}`);
        console.log('  请允许当前工具读取该文件，或在 config.env 为 WEB_ACCESS_BROWSER 设置已核对的 WEB_ACCESS_CDP_PORT；不会猜测端口或切换浏览器');
        return { proceed: false, exitCode: 1 };
      }
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
      if (result.inaccessible?.length) {
        console.log(`browser: 文件访问受限 — ${result.inaccessible.map(b => `${b.label} (${b.code})`).join('、')}`);
        console.log('  请允许当前工具读取调试端口文件，或在 config.env 明确配置 WEB_ACCESS_BROWSER 与已核对的 WEB_ACCESS_CDP_PORT');
        return { proceed: false, exitCode: 1 };
      }
      // 末路兜底：尝试常见固定端口（用户手动 --remote-debugging-port=9222 启动的场景）
      const fallback = await findFallbackPort();
      if (fallback) {
        console.log(`browser: ok (port ${fallback.port}) [通过手动调试端口连接]`);
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

  // 先复用服务，避免调试端口文件缺失或未设置偏好阻断现有连接。
  const health = await httpGetJson(HEALTH_URL);
  let browserId = opts.browser || getConfiguredBrowserId();
  if (health?.status !== 'ok') {
    const resolved = await resolveAndReport(opts.browser);
    if (!resolved.proceed) process.exit(resolved.exitCode);
    browserId = resolved.browserId;
  }

  const proxyOk = await ensureProxy(browserId, opts.browser, health);
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
