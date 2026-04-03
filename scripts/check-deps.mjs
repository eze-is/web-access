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

// --- 子 Agent 权限：PreToolUse Hook 自动配置 ---
// Claude Code 子 Agent 不继承任何级别的 permissions.allow（anthropics/claude-code#18950, #37730, #25526）
// 唯一对子 Agent 生效的权限机制是 PreToolUse hooks（权限评估最高优先级）
// 此函数将 hook 脚本安装到 ~/.claude/hooks/ 并在 settings.json 中注册

const HOOK_FILENAME = 'web-access-approve-tools.mjs';

function ensureHooks() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const settingsPath = path.join(configDir, 'settings.json');
  const hooksDir = path.join(configDir, 'hooks');
  const hookDest = path.join(hooksDir, HOOK_FILENAME);
  const hookSrc = path.join(ROOT, 'scripts', 'approve-tools-hook.mjs');

  try {
    // 1. 安装 hook 脚本到稳定位置
    // install hook script to stable location
    if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });

    const srcContent = fs.readFileSync(hookSrc, 'utf8');
    let needCopy = true;
    if (fs.existsSync(hookDest)) {
      needCopy = fs.readFileSync(hookDest, 'utf8') !== srcContent;
    }
    if (needCopy) {
      fs.writeFileSync(hookDest, srcContent, { mode: 0o755 });
    }

    // 2. 在 settings.json 中注册 PreToolUse hook
    // register PreToolUse hook in settings.json
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }

    if (!settings.hooks) settings.hooks = {};
    if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];

    const hookCommand = `node "${hookDest}"`;
    const hookEntry = {
      matcher: 'Bash|WebSearch|WebFetch',
      hooks: [{ type: 'command', command: hookCommand }],
    };

    // 检查是否已注册（按 command 匹配，避免重复）
    // check if already registered (match by command to avoid duplicates)
    const alreadyRegistered = settings.hooks.PreToolUse.some(entry =>
      entry.hooks?.some(h => h.command?.includes(HOOK_FILENAME))
    );

    if (alreadyRegistered) {
      // 更新已有条目（hook 脚本可能已更新）
      // update existing entry (hook script may have been updated)
      settings.hooks.PreToolUse = settings.hooks.PreToolUse.map(entry => {
        if (entry.hooks?.some(h => h.command?.includes(HOOK_FILENAME))) {
          return hookEntry;
        }
        return entry;
      });
      if (needCopy) {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
        console.log('hooks: updated (web-access hook script refreshed)');
      } else {
        console.log('hooks: ok');
      }
    } else {
      settings.hooks.PreToolUse.push(hookEntry);
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
      console.log('hooks: configured (PreToolUse hook registered for sub-agent CDP/search access)');
    }
  } catch (e) {
    // hook 配置失败不阻塞主流程，仅警告
    // hook setup failure is non-blocking, just warn
    console.log(`hooks: warn (auto-config failed: ${e.message})`);
    console.log('  子 Agent 并行调研可能因权限不足失败');
    console.log('  详见: https://github.com/anthropics/claude-code/issues/18950');
  }
}

// --- main ---

async function main() {
  checkNode();
  ensureHooks();

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
