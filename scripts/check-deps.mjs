#!/usr/bin/env node
// 环境检查 + 确保 CDP Proxy 就绪
//
// 用法：
//   node check-deps.mjs                         默认行为：读 config.env 偏好
//   node check-deps.mjs --browser <数据目录>     本次临时指定浏览器（不写 config.env；也接受旧值 chrome / edge 等）
//
// 持久偏好 → ~/.web-access/config.env（用户数据目录，见 user-data.mjs）
// 单次覆盖 → --browser 命令行参数（全链路 argv，不碰 process.env）
// 未设置浏览器 → exit 2，输出应用数据根目录的最外层文件夹名和首次配置步骤（探测见 browser-probe.mjs）

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectBrowser, getConfiguredBrowser, validateBrowser, sameBrowser, browserLabel, explainUnavailable, INSPECT_HINT } from './browser-discovery.mjs';
import { appDataRoots, listAppDataRoots } from './browser-probe.mjs';
import { userDataPaths, migrateLegacyData } from './user-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_SCRIPT = path.join(ROOT, 'scripts', 'cdp-proxy.mjs');
const PROXY_PORT = Number(process.env.CDP_PROXY_PORT || 3456);
const HEALTH_URL = `http://127.0.0.1:${PROXY_PORT}/health`;
const USER_DATA = userDataPaths();
const CONFIG_PATH = USER_DATA.config;
const CONFIG_TEMPLATE = path.join(ROOT, 'templates', 'config.env.template');
const PROBE_SCRIPT = path.join(ROOT, 'scripts', 'browser-probe.mjs');

// --- 参数解析 ---

function parseArgs(argv) {
  const opts = { browser: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--browser' && argv[i + 1]) { opts.browser = argv[i + 1]; i++; }
    else if (argv[i].startsWith('--browser=')) { opts.browser = argv[i].slice('--browser='.length); }
  }
  return opts;
}

// --- 旧版本用户数据一次性迁移：失败不阻塞，旧文件仍在原处，下次重试。返回是否已完成（含此前已完成） ---

function migrateUserData() {
  try {
    const result = migrateLegacyData();
    if (result?.sources.length) {
      const parts = result.sources.map(({ from, config, patterns }) => {
        const items = [config && 'config.env', patterns && `${patterns} 个站点经验文件`].filter(Boolean).join('、');
        return `${items}（来自 ${from}）`;
      });
      console.log(`user-data: 已迁移 ${parts.join('；')} → ${result.dir}（旧文件保留未删）`);
    }
    return true;
  } catch (error) {
    console.log(`user-data: warn — 旧数据迁移到 ${USER_DATA.dir} 失败（${error.message}），旧文件仍在原处，下次运行重试`);
    return false;
  }
}

// --- 首次安装：从模板创建 config.env ---

function ensureConfigExists() {
  if (fs.existsSync(CONFIG_PATH)) return;
  try {
    fs.mkdirSync(USER_DATA.dir, { recursive: true });
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

// 浏览器身份按数据目录比较：旧值 chrome 与其标准路径视为同一浏览器，兼容升级前已运行的实例。
function matchesBrowser(health, expectedBrowser) {
  if (!expectedBrowser) return true;
  const runningId = health.browser?.id;
  const runningLabel = health.browser?.label || runningId || 'unknown';
  if (!runningId || runningId === 'unknown') {
    if (health.connected !== true) return true; // 断线实例恢复后会报告真实身份，再比较
    console.log(`proxy: 无法确认当前连接的浏览器是否为 ${browserLabel(expectedBrowser)}，保留已有实例`);
    return false;
  }
  if (!sameBrowser(runningId, expectedBrowser)) {
    console.log(`proxy: 浏览器不一致 — 当前实例使用 ${runningLabel}（${runningId}），但本次需要 ${browserLabel(expectedBrowser)}（${expectedBrowser}）`);
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

// --- 首次配置：只列应用数据根目录的最外层文件夹名，不进入任何文件夹 ---

function printFirstRunGuide() {
  console.log(`browser: 未设置 — 首次使用需要选定浏览器（写入 ${CONFIG_PATH} 的 WEB_ACCESS_BROWSER）`);
  const listings = listAppDataRoots();
  if (!listings.length) {
    console.log(`  当前平台（${os.platform()}）没有可列出的应用数据根目录（${appDataRoots().join('、') || '未知'}），请向用户询问浏览器数据目录`);
  }
  for (const { root, folders, code } of listings) {
    if (code) console.log(`  应用数据根目录 ${root}：无法列出（${code}）`);
    else console.log(`  应用数据根目录 ${root} 下的文件夹：\n    ${folders.join(', ') || '（空）'}`);
  }
  console.log('  Agent 下一步：');
  console.log('    1. 从文件夹名认出 Chromium 内核浏览器（如 Google、Microsoft Edge、BraveSoftware、Arc、Dia、Vivaldi、com.operasoftware.Opera）');
  console.log(`    2. 只探测认出的文件夹：node "${PROBE_SCRIPT}" <文件夹名> [更多文件夹名]（只接受上面根目录下的相对路径）`);
  console.log('    3. 把探测到的浏览器和远程调试状态告诉用户，询问用哪个（即使只找到一个也要问）');
  console.log(`    4. 把用户选定的数据目录写入 ${CONFIG_PATH}：WEB_ACCESS_BROWSER=<数据目录路径>`);
  console.log(`    5. 远程调试未开启时，请用户在该浏览器的${INSPECT_HINT}，再重新运行本检查`);
  console.log('  仅本次使用（不写配置）：node check-deps.mjs --browser <数据目录路径>');
}

// --- 配置错误：与共享服务是否在运行无关，先于复用判断报告，不引导停止服务 ---

function printConfigError(message, { browserValue = false } = {}) {
  console.log(`browser: 配置错误 — ${message}`);
  if (browserValue) {
    console.log('  WEB_ACCESS_BROWSER / --browser 应为浏览器的用户数据目录，即含 Local State 的那一层' +
      '（如 ~/Library/Application Support/Dia/User Data、%LOCALAPPDATA%\\Google\\Chrome\\User Data），不能只写文件夹名或相对路径');
    console.log(`  不确定路径时用 node "${PROBE_SCRIPT}" <文件夹名> 确认，改正 ${CONFIG_PATH} 后重新运行`);
  } else {
    console.log(`  改正 ${CONFIG_PATH} 后重新运行`);
  }
  console.log('  这是配置问题，不需要停止或重启共享服务');
}

// --- 输出浏览器选择结果，返回是否可以继续启动 proxy ---

async function resolveAndReport(override) {
  const result = await selectBrowser(override);

  switch (result.kind) {
    case 'config-error': {
      printConfigError(result.message);
      return { proceed: false, exitCode: 1 };
    }
    case 'ok': {
      const sourceTag = result.source === 'override' ? '[--browser 指定]' : '[config.env 偏好]';
      console.log(`browser: ok (${result.browser.label}, port ${result.browser.port}) ${sourceTag}`);
      console.log(`  数据目录：${result.browser.id}`);
      return { proceed: true, browserId: result.browser.id };
    }
    case 'unset': {
      printFirstRunGuide();
      return { proceed: false, exitCode: 2 };
    }
    case 'unavailable': {
      const [first, ...rest] = explainUnavailable(result);
      console.log(`browser: error — ${first}`);
      for (const line of rest) console.log(`  ${line}`);
      if (result.source === 'preference') {
        console.log(`  也可以编辑 ${CONFIG_PATH} 改默认浏览器，或本次临时换浏览器：node check-deps.mjs --browser <数据目录路径>`);
      }
      return { proceed: false, exitCode: 1 };
    }
  }
}

// --- main ---

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // 先迁移，再从模板建配置：迁移失败时不建，否则下次重试时空模板会挡住旧偏好（复制不覆盖已有文件）
  if (migrateUserData()) ensureConfigExists();
  checkNode();

  // 站点经验是本地数据，在浏览器检查或连接等待前输出，失败时也能读取已有经验。
  let sites = [];
  try {
    sites = fs.readdirSync(USER_DATA.sitePatterns)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
  } catch {}
  console.log(`\nsite-patterns: ${sites.length ? sites.join(', ') : '（暂无）'}`);
  console.log(`  目录：${USER_DATA.sitePatterns}（文件名 {domain}.md）`);

  // 期望的浏览器值本身无效时先报配置错误，不进入「浏览器不一致 → 停止服务」的复用判断。
  let browserId = opts.browser || getConfiguredBrowser();
  if (browserId) {
    try { validateBrowser(browserId); }
    catch (error) {
      printConfigError(`${opts.browser ? '--browser' : 'WEB_ACCESS_BROWSER'} 的值无效：${error.message}`, { browserValue: true });
      process.exit(1);
    }
  }

  // 先复用服务，避免调试端口文件缺失或未设置偏好阻断现有连接。
  const health = await httpGetJson(HEALTH_URL);
  if (health?.status !== 'ok') {
    const resolved = await resolveAndReport(opts.browser);
    if (!resolved.proceed) process.exit(resolved.exitCode);
    browserId = resolved.browserId;
  }

  const proxyOk = await ensureProxy(browserId, opts.browser, health);
  if (!proxyOk) process.exit(1);
}

await main();
