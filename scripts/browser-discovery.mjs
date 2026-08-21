// 浏览器 CDP 端口发现 + 选择 - 单一职责模块
// 被 check-deps.mjs 和 cdp-proxy.mjs 共享。
//
// 选择规则（resolution）：
//   1. 调用方传入 override 参数（来自命令行 --browser） → 严格模式，找不到则硬错
//   2. config.env 里 WEB_ACCESS_BROWSER 设了 → 严格模式，找不到则硬错
//   3. 都没设 → "ask" 模式，提示调用方询问用户
//
// 不擅自降级：偏好不可用一律硬错，让用户介入。
// 持久态只有 config.env 一处；override 是单次 spawn 通过命令行参数表达，不读 process.env。

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(SKILL_ROOT, 'config.env');

// 已知支持 chrome://inspect#remote-debugging toggle 的浏览器
// 加新浏览器：只改这里
export function knownBrowsers() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || '';
  switch (os.platform()) {
    case 'darwin':
      return [
        { id: 'chrome',        label: 'Chrome',         devToolsPath: path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort') },
        { id: 'chrome-canary', label: 'Chrome Canary',  devToolsPath: path.join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort') },
        { id: 'chromium',      label: 'Chromium',       devToolsPath: path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort') },
        { id: 'edge',          label: 'Microsoft Edge', devToolsPath: path.join(home, 'Library/Application Support/Microsoft Edge/DevToolsActivePort') },
      ];
    case 'linux':
      return [
        { id: 'chrome',   label: 'Chrome',         devToolsPath: path.join(home, '.config/google-chrome/DevToolsActivePort') },
        { id: 'chromium', label: 'Chromium',       devToolsPath: path.join(home, '.config/chromium/DevToolsActivePort') },
        { id: 'edge',     label: 'Microsoft Edge', devToolsPath: path.join(home, '.config/microsoft-edge/DevToolsActivePort') },
      ];
    case 'win32':
      return [
        { id: 'chrome',   label: 'Chrome',         devToolsPath: path.join(localAppData, 'Google/Chrome/User Data/DevToolsActivePort') },
        { id: 'chromium', label: 'Chromium',       devToolsPath: path.join(localAppData, 'Chromium/User Data/DevToolsActivePort') },
        { id: 'edge',     label: 'Microsoft Edge', devToolsPath: path.join(localAppData, 'Microsoft/Edge/User Data/DevToolsActivePort') },
      ];
    default:
      return [];
  }
}

// TCP 端口监听检测
// 用 TCP connect 而非 WebSocket，避免触发浏览器的远程调试授权弹窗。
// EPERM / EACCES 表示当前执行环境不允许访问 localhost，不能据此判断浏览器未开启调试。
export function classifyPortError(errorCode) {
  return errorCode === 'EPERM' || errorCode === 'EACCES' ? 'restricted' : 'unreachable';
}

export function checkPort(port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise((resolve) => {
    let socket;
    let timer;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(result);
    };

    try {
      socket = net.createConnection(port, host);
    } catch (error) {
      finish({ status: classifyPortError(error?.code), errorCode: error?.code || null });
      return;
    }

    timer = setTimeout(() => finish({ status: 'unreachable', errorCode: 'ETIMEDOUT' }), timeoutMs);
    socket.once('connect', () => finish({ status: 'open', errorCode: null }));
    socket.once('error', (error) => {
      finish({ status: classifyPortError(error?.code), errorCode: error?.code || null });
    });
  });
}

// 读 config.env 文件（不写入 process.env，分清来源）
// 格式：KEY=VALUE，# 开头是注释
function readConfig() {
  const cfg = {};
  let content;
  try { content = fs.readFileSync(CONFIG_PATH, 'utf8'); }
  catch { return cfg; }
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k && v) cfg[k] = v;
  }
  return cfg;
}

// 返回所有端口可达或被当前执行环境阻止探测的浏览器。
async function detectAll() {
  const detected = [];
  const restricted = [];
  for (const browser of knownBrowsers()) {
    let content;
    try { content = fs.readFileSync(browser.devToolsPath, 'utf8'); }
    catch { continue; }
    const lines = content.trim().split(/\r?\n/).filter(Boolean);
    const port = parseInt(lines[0], 10);
    if (!(port > 0 && port < 65536)) continue;
    const candidate = { ...browser, port, wsPath: lines[1] || null };
    const probe = await checkPort(port);
    if (probe.status === 'open') detected.push(candidate);
    else if (probe.status === 'restricted') restricted.push({ ...candidate, errorCode: probe.errorCode });
  }
  return { detected, restricted };
}

// 决策入口
// 参数：override — 调用方解析自命令行 --browser 的值（null 表示未传）
// 返回 { kind, browser?, source?, detected, restricted, configured, override? }
//   kind ∈ 'ok' | 'ambiguous' | 'restricted' | 'mismatch' | 'empty'
//   source ∈ 'override' | 'preference' | undefined
//   ambiguous = 没设偏好 + 至少一个浏览器开了 toggle，需问用户
//   restricted = 找到了调试端口文件，但当前环境无权连接 localhost
//   mismatch  = override/配偏好设了但未检测到对应 toggle，硬错
//   empty     = 0 浏览器开 toggle 且未设偏好/override
export function resolveBrowserSelection({ detected, restricted, configured, override }) {
  // 1. 命令行 override（最高优先，单次有效）
  if (override) {
    const match = detected.find(b => b.id === override);
    if (match) return { kind: 'ok', browser: match, source: 'override', detected, restricted, configured, override };
    const blocked = restricted.find(b => b.id === override);
    if (blocked) return { kind: 'restricted', browser: blocked, source: 'override', detected, restricted, configured, override };
    return { kind: 'mismatch', source: 'override', detected, restricted, configured, override };
  }

  // 2. config.env preference（持久）
  if (configured) {
    const match = detected.find(b => b.id === configured);
    if (match) return { kind: 'ok', browser: match, source: 'preference', detected, restricted, configured };
    const blocked = restricted.find(b => b.id === configured);
    if (blocked) return { kind: 'restricted', browser: blocked, source: 'preference', detected, restricted, configured };
    return { kind: 'mismatch', source: 'preference', detected, restricted, configured };
  }

  // 3. 无偏好 —— 一律询问用户（哪怕 detected 只有一个）
  if (detected.length === 0) {
    if (restricted.length) return { kind: 'restricted', detected, restricted, configured };
    return { kind: 'empty', detected, restricted, configured };
  }
  return { kind: 'ambiguous', detected, restricted, configured };
}

export async function selectBrowser(override = null) {
  const { detected, restricted } = await detectAll();
  const configured = readConfig().WEB_ACCESS_BROWSER || null;
  return resolveBrowserSelection({ detected, restricted, configured, override });
}

// 兜底：扫描常用固定端口
// 适用场景：用户手动 --remote-debugging-port=9222 启动浏览器，
// 此时 DevToolsActivePort 可能不在默认 user-data-dir。
export async function findFallbackPort() {
  const restricted = [];
  for (const port of [9222, 9229, 9333]) {
    const probe = await checkPort(port);
    if (probe.status === 'open') return { kind: 'ok', port };
    if (probe.status === 'restricted') restricted.push({ port, errorCode: probe.errorCode });
  }
  if (restricted.length) return { kind: 'restricted', restricted };
  return { kind: 'empty' };
}
