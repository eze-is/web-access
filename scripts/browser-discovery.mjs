// 浏览器身份 + 端口发现 + 选择 - 单一职责模块
// 被 check-deps.mjs、cdp-proxy.mjs、proxy-maintenance.mjs、browser-probe.mjs 共享。
//
// 浏览器身份 = 规范化后的用户数据目录绝对路径（浏览器把 DevToolsActivePort 写在它的根部）；
// 目录存在时取真实路径，软链接、macOS / Windows 的大小写差异都归一到同一身份。
// 不维护浏览器名单：任何 Chromium 内核浏览器给出数据目录即可使用。
// 旧值 chrome / chrome-canary / chromium / edge 按平台对应到标准目录，只为兼容老配置，不再扩充。
// 显示名取路径里最有辨识度的文件夹名，只用于展示，不参与身份比较。
//
// 选择规则（resolution）：
//   1. 调用方传入 override（来自命令行 --browser，单次有效）
//   2. config.env 的 WEB_ACCESS_BROWSER（持久）
//   3. 都没设 → unset，由调用方引导首次配置（见 browser-probe.mjs）；不扫描目录、不猜端口
//
// 只读所选目录的 DevToolsActivePort，并只做 TCP 探测（不建 WebSocket，不触发授权弹窗）。
// 不擅自降级：所选浏览器不可用一律硬错，不换浏览器、不扫描固定端口。
// 持久态只有 config.env 一处（~/.web-access/config.env，见 user-data.mjs）；override 只走命令行参数，不读 process.env。

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { userDataPaths } from './user-data.mjs';

export const INSPECT_HINT = '地址栏打开 chrome://inspect/#remote-debugging（Edge 为 edge://inspect/#remote-debugging），' +
  '勾选 "Allow remote debugging for this browser instance"';

// 旧配置值 → 标准数据目录（路径事实见 Chromium user_data_dir.md 与微软 Edge 文档）
function legacyDataDir(value) {
  const alias = value.toLowerCase();
  const home = os.homedir();
  let dirs;
  switch (os.platform()) {
    case 'darwin': {
      const base = path.join(home, 'Library', 'Application Support');
      dirs = {
        chrome: path.join(base, 'Google', 'Chrome'),
        'chrome-canary': path.join(base, 'Google', 'Chrome Canary'),
        chromium: path.join(base, 'Chromium'),
        edge: path.join(base, 'Microsoft Edge'),
      };
      break;
    }
    case 'linux': {
      const base = path.join(home, '.config');
      dirs = {
        chrome: path.join(base, 'google-chrome'),
        'chrome-canary': path.join(base, 'google-chrome-canary'),
        chromium: path.join(base, 'chromium'),
        edge: path.join(base, 'microsoft-edge'),
      };
      break;
    }
    case 'win32': {
      const local = process.env.LOCALAPPDATA;
      dirs = {
        chrome: ['Google', 'Chrome', 'User Data'],
        'chrome-canary': ['Google', 'Chrome SxS', 'User Data'],
        chromium: ['Chromium', 'User Data'],
        edge: ['Microsoft', 'Edge', 'User Data'],
      };
      if (!Object.hasOwn(dirs, alias)) return null;
      if (!local) throw new Error(`旧配置值 ${alias} 需要环境变量 LOCALAPPDATA，当前未设置`);
      return path.join(local, ...dirs[alias]);
    }
    default:
      return null;
  }
  return Object.hasOwn(dirs, alias) ? dirs[alias] : null;
}

// 展开用户写法：去掉成对引号、展开 ~，Windows 另展开 %LOCALAPPDATA% / %APPDATA%。不判断是否绝对路径。
export function expandPath(raw) {
  let value = String(raw).trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  if (value === '~' || value.startsWith('~/') || (os.platform() === 'win32' && value.startsWith('~\\'))) {
    value = path.join(os.homedir(), value.slice(1));
  }
  if (os.platform() === 'win32') {
    value = value.replace(/%(LOCALAPPDATA|APPDATA)%/gi, (_match, name) => {
      const expanded = process.env[name.toUpperCase()];
      if (!expanded) throw new Error(`环境变量 ${name.toUpperCase()} 未设置，无法展开 ${raw}`);
      return expanded;
    });
  }
  return value;
}

// 配置值（数据目录路径或旧值）→ 浏览器 { id: 数据目录绝对路径, label: 显示名 }。无效写法抛出可直接展示的错误。
// 只做路径换算，不要求目录存在（比较升级前实例报告的旧值时也用它）；目录是否有效见 validateBrowser。
export function resolveBrowser(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error('浏览器配置为空');
  const legacy = legacyDataDir(value.replace(/^(["'])(.*)\1$/, '$2').trim());
  const expanded = legacy || expandPath(value);
  if (!path.isAbsolute(expanded)) {
    throw new Error(`"${value}" 既不是浏览器数据目录的绝对路径，也不是旧配置值（chrome / chrome-canary / chromium / edge）`);
  }
  let id = path.resolve(expanded);
  try { id = fs.realpathSync.native(id); } catch { /* 目录不存在或无权限时保留字面规范化结果 */ }
  return { id, label: displayName(id) };
}

// 配置值必须指向真实的 Chromium 用户数据目录（含 Local State）。无效时抛出可直接展示的错误。
// 无权限查看时无法判断，按有效处理，由读取端口文件时如实报告权限问题。
export function validateBrowser(raw) {
  const browser = resolveBrowser(raw);
  const check = (file, test, message) => {
    let stat;
    try { stat = fs.statSync(file, { throwIfNoEntry: false }); }
    catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') return;
      throw error;
    }
    if (!stat || !test(stat)) throw new Error(message);
  };
  check(browser.id, stat => stat.isDirectory(), `${browser.id} 不存在或不是文件夹`);
  check(path.join(browser.id, 'Local State'), stat => stat.isFile(),
    `${browser.id} 里没有 Local State，不是 Chromium 浏览器的用户数据目录`);
  return browser;
}

// 显示名：从路径末尾跳过通用的 `User Data` 层，取第一个文件夹名（Dia/User Data → Dia，Google/Chrome → Chrome）
export function displayName(dataDir) {
  const parts = String(dataDir).split(/[\\/]+/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].toLowerCase() !== 'user data') return parts[i];
  }
  return String(dataDir);
}

// 两个配置值 / 运行中实例的 browser.id 是否指同一浏览器。旧值与其标准路径视为同一个；无法解析（如旧版 unknown）不相等。
export function sameBrowser(a, b) {
  let left;
  let right;
  try {
    left = resolveBrowser(a).id;
    right = resolveBrowser(b).id;
  } catch { return false; }
  return left === right;
}

// 展示用：能解析就给显示名，否则原样返回
export function browserLabel(value) {
  try { return resolveBrowser(value).label; }
  catch { return String(value); }
}

// TCP 端口监听检测
// 用 TCP connect 而非 WebSocket，避免触发浏览器的远程调试授权弹窗。
export function checkPort(port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, host);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error',   () => { clearTimeout(timer); resolve(false); });
  });
}

// 只探测同一个已选端口的 loopback 地址；优先 IPv4，不猜测其它端口或连接远端主机。
export async function findLoopbackHost(port) {
  if (await checkPort(port)) return '127.0.0.1';
  if (await checkPort(port, '::1')) return '::1';
  return null;
}

// 读数据目录根部的 DevToolsActivePort（第 1 行端口，第 2 行 wsPath）。只读这一个文件。
// 返回 { port, wsPath } 或 { reason, code? }，reason ∈ not-enabled | unreadable | invalid
export function readActivePort(dataDir) {
  const file = path.join(dataDir, 'DevToolsActivePort');
  let content;
  try { content = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { reason: 'not-enabled' };
    return { reason: 'unreadable', code: error.code || 'EIO' };
  }
  const lines = content.trim().split(/\r?\n/).filter(Boolean);
  const port = Number(lines[0]);
  if (!/^\d+$/.test(lines[0] || '') || port < 1 || port > 65535) return { reason: 'invalid' };
  return { port, wsPath: lines[1] || null };
}

// 读 config.env 文件（不写入 process.env，分清来源）
// 格式：KEY=VALUE，# 开头是注释
function readConfig() {
  const cfg = {};
  let content;
  try { content = fs.readFileSync(userDataPaths().config, 'utf8'); }
  catch { return cfg; }
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k) cfg[k] = v;
  }
  return cfg;
}

// 读取偏好原值（路径或旧值）无需探测浏览器；已有 Proxy 的连接状态由 /health 说明。
export function getConfiguredBrowser() {
  return readConfig().WEB_ACCESS_BROWSER || null;
}

// 决策入口
// 参数：override — 调用方解析自命令行 --browser 的值（null 表示未传）
// 返回 { kind, browser?, source?, override?, reason?, code?, port?, message? }
//   kind ∈ 'ok' | 'unavailable' | 'unset' | 'config-error'
//   ok          = 所选浏览器端口在监听；browser 含 { id, label, host, port, wsPath, endpointSource? }
//   unavailable = 所选浏览器连不上（reason 同 readActivePort，另有 offline = 端口未监听），硬错
//   config-error = 配置本身有误（值无效、目录不存在或不是 Chromium 数据目录、显式端口有误）
//   unset       = 没有偏好也没有 override，需要首次配置
//   source ∈ 'override' | 'preference'
export async function selectBrowser(override = null) {
  const config = readConfig();
  const configured = config.WEB_ACCESS_BROWSER || null;

  // 显式端口只绑定已配置的浏览器，不能被另一个浏览器的 override 借用。
  let configuredEndpoint = null;
  if (config.WEB_ACCESS_CDP_PORT) {
    const rawPort = config.WEB_ACCESS_CDP_PORT;
    const port = Number(rawPort);
    if (!configured) return configError('WEB_ACCESS_CDP_PORT 必须与 WEB_ACCESS_BROWSER 一起配置');
    if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
      return configError('WEB_ACCESS_CDP_PORT 必须是 1 到 65535 的十进制整数');
    }
    try { configuredEndpoint = { id: resolveBrowser(configured).id, port }; }
    catch (error) { return configError(`WEB_ACCESS_BROWSER 的值无效：${error.message}`); }
  }

  const raw = override || configured;
  if (!raw) return { kind: 'unset' };
  const source = override ? 'override' : 'preference';
  let browser;
  try { browser = validateBrowser(raw); }
  catch (error) {
    return configError(`${override ? '--browser' : 'WEB_ACCESS_BROWSER'} 的值无效：${error.message}`);
  }
  const facts = { browser, source, ...(override ? { override } : {}) };

  if (configuredEndpoint?.id === browser.id) {
    const { port } = configuredEndpoint;
    const host = await findLoopbackHost(port);
    if (!host) return { kind: 'unavailable', ...facts, reason: 'offline', port, endpointSource: 'config-port' };
    return { kind: 'ok', ...facts, browser: { ...browser, host, port, wsPath: null, endpointSource: 'config-port' } };
  }

  const active = readActivePort(browser.id);
  if (!active.port) return { kind: 'unavailable', ...facts, ...active };
  const host = await findLoopbackHost(active.port);
  if (!host) return { kind: 'unavailable', ...facts, reason: 'offline', port: active.port };
  return { kind: 'ok', ...facts, browser: { ...browser, host, port: active.port, wsPath: active.wsPath } };
}

function configError(message) {
  return { kind: 'config-error', message };
}

// 把 unavailable 结果解释为给 Agent 的处理步骤（check-deps 逐行打印，Proxy 合并为一条错误）
export function explainUnavailable(result) {
  const { browser, reason } = result;
  const config = userDataPaths().config;
  const who = `${result.source === 'override' ? '本次指定' : '默认偏好'}的浏览器 ${browser.label}（${browser.id}）`;
  if (reason === 'unreadable') {
    return [
      `无法读取 ${browser.label} 的调试端口文件（${result.code}）：${path.join(browser.id, 'DevToolsActivePort')}`,
      `请允许当前工具读取该文件，或在 ${config} 为 WEB_ACCESS_BROWSER 设置已核对的 WEB_ACCESS_CDP_PORT；不会猜测端口或切换浏览器`,
    ];
  }
  const detail = {
    'not-enabled': '数据目录里没有 DevToolsActivePort（浏览器未运行，或远程调试开关未开启）',
    invalid: 'DevToolsActivePort 内容无效',
    offline: result.endpointSource === 'config-port'
      ? `WEB_ACCESS_CDP_PORT=${result.port} 未在监听`
      : `DevToolsActivePort 记录的端口 ${result.port} 未在监听（浏览器已退出或开关已关闭）`,
  }[reason] || reason;
  return [
    `${who} 没连上：${detail}`,
    'Agent 处理顺序：',
    `  1. 先用系统命令打开 ${browser.label}（按平台自行选择，如 macOS 的 open -a），再重试`,
    `  2. 若仍失败，多半是远程调试开关没启用 —— 告诉用户：在 ${browser.label} 的${INSPECT_HINT}`,
  ];
}
