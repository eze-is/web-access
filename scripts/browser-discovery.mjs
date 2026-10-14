// 浏览器 CDP 端口发现 + 选择 - 单一职责模块
// 被 check-deps.mjs 和 cdp-proxy.mjs 共享。
//
// 发现来源有两层（由 config.env 的 WEB_ACCESS_BROWSER_DISCOVERY 控制）：
//   auto（默认）  = 白名单优先 + 通用扫描兜底：先按 knownBrowsers 白名单发现
//                   （行为与只有白名单时一致），白名单外的 Chromium 系浏览器由
//                   DevToolsActivePort 通用扫描补上（如 Arc、Dia 这类未收录品牌）
//   whitelist     = 只用白名单（与引入扫描前完全一致）
//   scan          = 只用通用扫描，不读白名单
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
// 加新浏览器：只改这里；白名单外的 Chromium 系浏览器无需登记，
// 由通用扫描自动发现（见 scanDevToolsActivePort）。
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

// --- 通用扫描（白名单外 Chromium 系浏览器兜底）---

// 各平台 Chromium 系浏览器用户数据目录的公共父目录
function chromiumProfilesRoot() {
  switch (os.platform()) {
    case 'darwin': return path.join(os.homedir(), 'Library/Application Support');
    case 'linux':  return path.join(os.homedir(), '.config');
    case 'win32':  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local');
    default: return null;
  }
}

// 从 DevToolsActivePort 文件路径推断浏览器 id 与 label（不硬编码品牌）。
// 相对路径形如 "Google/Chrome/DevToolsActivePort"、"Dia/User Data/DevToolsActivePort"、
// "BraveSoftware/Brave-Browser/DevToolsActivePort"：
//   label = 去掉末段文件名；末段目录恰为 "User Data" 时一并去掉，剩余目录名拼接
//   id    = label 规范化（小写、空白与斜杠转连字符），供 config.env / --browser 匹配
function deriveBrowserFromPath(devToolsPath, baseDir) {
  const rel = path.relative(baseDir, devToolsPath);
  const parts = rel.split(path.sep);
  const nameParts = parts.slice(0, -1);
  const labelParts = nameParts[nameParts.length - 1] === 'User Data' ? nameParts.slice(0, -1) : nameParts;
  const label = labelParts.join(' ');
  const id = label.toLowerCase().replace(/[\s/]+/g, '-');
  return { id, label: label || id };
}

// 扫描各平台用户数据目录下的 DevToolsActivePort 文件，只列候选：
// 不读端口内容、不发 TCP。Chromium 系浏览器开启远程调试后都会写这个文件，
// 品牌差异只在目录层级，四种形态都覆盖：
//   vendor/DevToolsActivePort                        （如 Chromium、Microsoft Edge）
//   vendor/User Data/DevToolsActivePort              （如 Dia、Arc）
//   vendor/product/DevToolsActivePort                （如 Google/Chrome、BraveSoftware/Brave-Browser）
//   vendor/product/User Data/DevToolsActivePort      （如 Windows 的 Google/Chrome/User Data）
// 返回 [{ id, label, devToolsPath }]，同 id 只保留第一个。
export function scanDevToolsActivePort() {
  const baseDir = chromiumProfilesRoot();
  if (!baseDir || !fs.existsSync(baseDir)) return [];
  let entries;
  try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); }
  catch { return []; }

  const results = [];
  const seen = new Set();
  const consider = (devToolsPath) => {
    const browser = { devToolsPath, ...deriveBrowserFromPath(devToolsPath, baseDir) };
    if (seen.has(browser.id)) return;
    seen.add(browser.id);
    results.push(browser);
  };

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const vendorDir = path.join(baseDir, entry.name);
    for (const candidate of [
      path.join(vendorDir, 'DevToolsActivePort'),
      path.join(vendorDir, 'User Data', 'DevToolsActivePort'),
    ]) {
      if (fs.existsSync(candidate)) consider(candidate);
    }
    let subEntries;
    try { subEntries = fs.readdirSync(vendorDir, { withFileTypes: true }); }
    catch { continue; }
    for (const sub of subEntries) {
      if (!sub.isDirectory()) continue;
      for (const nested of [
        path.join(vendorDir, sub.name, 'DevToolsActivePort'),
        path.join(vendorDir, sub.name, 'User Data', 'DevToolsActivePort'),
      ]) {
        if (fs.existsSync(nested)) consider(nested);
      }
    }
  }
  return results;
}

// 发现模式解析：非法值返回 null，由调用方硬错（不擅自降级到默认值）
function readDiscoveryMode(config) {
  const raw = (config.WEB_ACCESS_BROWSER_DISCOVERY || 'auto').trim().toLowerCase();
  if (raw === 'auto' || raw === 'whitelist' || raw === 'scan') return raw;
  return null;
}

// 按发现模式合成候选列表。
// auto：白名单优先——扫描结果与白名单指向同一端口文件（物理同一浏览器）或
//       id 冲突时让位于白名单，只补白名单外的浏览器；白名单条目本身保持不变。
function candidateBrowsers(mode) {
  const whitelist = knownBrowsers();
  if (mode === 'whitelist') return whitelist;
  const scanned = scanDevToolsActivePort();
  if (mode === 'scan') return scanned;
  const seenPath = new Set(whitelist.map(browser => browser.devToolsPath));
  const seenId = new Set(whitelist.map(browser => browser.id));
  const merged = [...whitelist];
  for (const browser of scanned) {
    if (seenPath.has(browser.devToolsPath) || seenId.has(browser.id)) continue;
    seenPath.add(browser.devToolsPath);
    seenId.add(browser.id);
    merged.push(browser);
  }
  return merged;
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
    if (k) cfg[k] = v;
  }
  return cfg;
}

// 读取偏好无需探测浏览器；已有 Proxy 的连接状态由 /health 说明。
export function getConfiguredBrowserId() {
  return readConfig().WEB_ACCESS_BROWSER || null;
}

// 显式端口只绑定已配置的浏览器，不能被另一个浏览器的 override 借用。
async function detectAll(browsers, configuredEndpoint) {
  const detected = [];
  const inaccessible = [];
  for (const browser of browsers) {
    if (configuredEndpoint?.id === browser.id) {
      if (await checkPort(configuredEndpoint.port)) {
        detected.push({ ...browser, port: configuredEndpoint.port, wsPath: null, endpointSource: 'config-port' });
      }
      continue;
    }
    let content;
    try { content = fs.readFileSync(browser.devToolsPath, 'utf8'); }
    catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        inaccessible.push({ ...browser, code: error.code });
      }
      continue;
    }
    const lines = content.trim().split(/\r?\n/).filter(Boolean);
    const port = parseInt(lines[0], 10);
    if (!(port > 0 && port < 65536)) continue;
    if (!(await checkPort(port))) continue;
    detected.push({ ...browser, port, wsPath: lines[1] || null });
  }
  return { detected, inaccessible };
}

// 决策入口
// 参数：override — 调用方解析自命令行 --browser 的值（null 表示未传）
// 返回 { kind, browser?, source?, detected, configured, override?, inaccessible, message? }
//   kind ∈ 'ok' | 'ambiguous' | 'mismatch' | 'empty' | 'config-error'
//   source ∈ 'override' | 'preference' | undefined
//   ambiguous = 没设偏好 + 至少一个浏览器开了 toggle，需问用户
//   mismatch  = override/配偏好设了但未检测到对应 toggle，硬错
//   empty     = 0 浏览器开 toggle 且未设偏好/override
export async function selectBrowser(override = null) {
  const config = readConfig();
  const configured = config.WEB_ACCESS_BROWSER || null;
  const mode = readDiscoveryMode(config);
  if (!mode) {
    const message = 'WEB_ACCESS_BROWSER_DISCOVERY 必须是 auto、whitelist 或 scan';
    return { kind: 'config-error', message, detected: [], configured, inaccessible: [] };
  }
  const browsers = candidateBrowsers(mode);
  let configuredEndpoint = null;
  if (config.WEB_ACCESS_CDP_PORT) {
    const rawPort = config.WEB_ACCESS_CDP_PORT;
    const port = Number(rawPort);
    const bound = browsers.some(browser => browser.id === configured);
    let message;
    if (!configured) message = 'WEB_ACCESS_CDP_PORT 必须与 WEB_ACCESS_BROWSER 一起配置';
    else if (mode !== 'scan' && !bound) {
      message = `WEB_ACCESS_CDP_PORT 绑定的浏览器 "${configured}" 不在当前平台的支持列表中`;
    } else if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
      message = 'WEB_ACCESS_CDP_PORT 必须是 1 到 65535 的十进制整数';
    }
    if (message) return { kind: 'config-error', message, detected: [], configured, inaccessible: [] };
    configuredEndpoint = { id: configured, port };
    // scan 模式没有静态白名单可校验：配置了显式端口的浏览器即使当前没被扫描到
    // （浏览器已关、端口文件不可读、自定义 user-data-dir），也作为候选参与探测，
    // 端口归属完全交给用户配置。
    if (!bound) browsers.push({ id: configured, label: configured, devToolsPath: null });
  }
  const { detected, inaccessible } = await detectAll(browsers, configuredEndpoint);
  const facts = { detected, configured, inaccessible };

  // 1. 命令行 override（最高优先，单次有效）
  if (override) {
    const match = detected.find(b => b.id === override);
    if (match) return { kind: 'ok', browser: match, source: 'override', ...facts, override };
    return { kind: 'mismatch', source: 'override', ...facts, override };
  }

  // 2. config.env preference（持久）
  if (configured) {
    const match = detected.find(b => b.id === configured);
    if (match) return { kind: 'ok', browser: match, source: 'preference', ...facts };
    return { kind: 'mismatch', source: 'preference', ...facts };
  }

  // 3. 无偏好 —— 一律询问用户（哪怕 detected 只有一个）
  if (detected.length === 0) {
    return { kind: 'empty', ...facts };
  }
  return { kind: 'ambiguous', ...facts };
}

// 兜底：扫描常用固定端口
// 适用场景：用户手动 --remote-debugging-port=9222 启动浏览器，
// 此时 DevToolsActivePort 可能不在默认 user-data-dir。
export async function findFallbackPort() {
  for (const port of [9222, 9229, 9333]) {
    if (await checkPort(port)) return port;
  }
  return null;
}
