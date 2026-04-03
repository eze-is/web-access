#!/usr/bin/env node
// 环境检查 + 确保 CDP Proxy 就绪（跨平台，替代 check-deps.sh）

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_SCRIPT = path.join(ROOT, 'scripts', 'cdp-proxy.mjs');
const PROXY_PORT = Number(process.env.CDP_PROXY_PORT || 3456);

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

// --- Chrome 调试端口检测（DevToolsActivePort 多路径 + 常见端口回退） ---

function activePortFiles() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || '';
  switch (os.platform()) {
    case 'darwin':
      return [
        path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
        path.join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort'),
        path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort'),
      ];
    case 'linux':
      return [
        path.join(home, '.config/google-chrome/DevToolsActivePort'),
        path.join(home, '.config/chromium/DevToolsActivePort'),
      ];
    case 'win32':
      return [
        path.join(localAppData, 'Google/Chrome/User Data/DevToolsActivePort'),
        path.join(localAppData, 'Chromium/User Data/DevToolsActivePort'),
      ];
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
    detached: true,
    stdio: ['ignore', logFd, logFd],
    ...(os.platform() === 'win32' ? { windowsHide: true } : {}),
  });
  child.unref();
  fs.closeSync(logFd);
}

async function ensureProxy() {
  const targetsUrl = `http://127.0.0.1:${PROXY_PORT}/targets`;

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
      console.log('⚠️  Chrome 可能有授权弹窗，请点击「允许」后等待连接...');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('❌ 连接超时，请检查 Chrome 调试设置');
  console.log(`  日志：${path.join(os.tmpdir(), 'cdp-proxy.log')}`);
  return false;
}

// --- 子 Agent 权限自动配置 ---
// Claude Code 子 Agent 不继承 settings.local.json 的会话级权限（anthropics/claude-code#18950）
// 但 settings.json 中的全局权限对所有 Agent（包括子 Agent）生效
// 此函数确保并行调研所需的权限已配置，避免子 Agent 因权限被拒而失败

const REQUIRED_PERMISSIONS = [
  'Bash(curl -s http://localhost:3456/*)',
  'Bash(curl -s -X POST "http://localhost:3456/*)',
  'Bash(node *check-deps*)',
  'Bash(node *cdp-proxy*)',
  'Bash(node "$CLAUDE_SKILL_DIR/*")',
  'WebSearch',
  'WebFetch(domain:r.jina.ai)',
];

function ensurePermissions() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const settingsPath = path.join(configDir, 'settings.json');

  try {
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }

    // 合并权限：只添加缺失项，不影响已有配置
    // merge permissions: only add missing entries, never remove existing ones
    if (!settings.permissions) settings.permissions = {};
    if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

    const existing = new Set(settings.permissions.allow);
    const missing = REQUIRED_PERMISSIONS.filter(p => !existing.has(p));

    if (missing.length === 0) {
      console.log('permissions: ok');
      return;
    }

    settings.permissions.allow.push(...missing);
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    console.log(`permissions: configured (added ${missing.length} rules for sub-agent CDP/search access)`);
  } catch (e) {
    // 权限配置失败不阻塞主流程，仅警告
    // permission setup failure is non-blocking, just warn
    console.log(`permissions: warn (auto-config failed: ${e.message})`);
    console.log('  子 Agent 并行调研可能因权限不足失败，可手动配置 ~/.claude/settings.json');
  }
}

// --- main ---

async function main() {
  checkNode();
  ensurePermissions();

  const chromePort = await detectChromePort();
  if (!chromePort) {
    console.log('chrome: not connected — 请确保 Chrome 已打开，然后访问 chrome://inspect/#remote-debugging 并勾选 Allow remote debugging');
    process.exit(1);
  }
  console.log(`chrome: ok (port ${chromePort})`);

  const proxyOk = await ensureProxy();
  if (!proxyOk) {
    process.exit(1);
  }
}

await main();
