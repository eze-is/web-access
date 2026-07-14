#!/usr/bin/env node
// Ensure the web-access CDP extension transport is running and report install state.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_SCRIPT = path.join(ROOT, 'scripts', 'cdp-proxy.mjs');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const PORT = Number(process.env.CDP_PROXY_PORT || 3456);
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;
const EXTENSION_SETTLE_MS = 3000;
const EXTENSION_WAIT_MS = 10000;
const EXTENSION_POLL_MS = 500;
const PROXY_STOP_WAIT_MS = 5000;
const PROXY_STOP_POLL_MS = 100;

async function main() {
  const proxyStarted = await ensureProxy();
  const health = await waitForExtension(proxyStarted);
  if (isExtensionReady(health)) {
    console.log(`cdp-extension: ready (${health.extension?.browser || 'browser'} ${health.extension?.version || ''})`);
    process.exit(0);
  }

  console.log('cdp-extension: proxy ready, extension not connected');
  console.log('  1. 打开 chrome://extensions 或 edge://extensions，并启用 Developer mode');
  console.log(`  2. 选择 Load unpacked，目录选择：${EXTENSION_DIR}`);
  console.log('  3. 保持扩展启用；完成这一次安装授权后，web-access 可通过 chrome.debugger 传递 CDP 命令，不再需要 Chrome remote-debugging 授权弹窗');
  console.log(`  4. 重新运行：node "${path.join(ROOT, 'scripts', 'check-cdp.mjs')}"`);
  process.exit(1);
}

async function ensureProxy() {
  const health = await getHealth();
  if (health?.status === 'ok') {
    if (health.backend === 'cdp-extension') return false;
    if (health.backend === 'cdp-native') {
      await stopNativeProxy(health);
    } else {
      throw new Error(`Port ${PORT} is occupied by an unknown backend; refusing to stop it`);
    }
  }

  const logFile = path.join(os.tmpdir(), 'web-access-cdp-proxy.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, CDP_TRANSPORT: 'extension', CDP_PROXY_PORT: String(PORT) },
    ...(os.platform() === 'win32' ? { windowsHide: true } : {}),
  });
  child.unref();
  fs.closeSync(logFd);

  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const current = await getHealth();
    if (current?.status === 'ok' && current.backend === 'cdp-extension') return true;
  }
  throw new Error(`CDP extension transport did not start; see ${logFile}`);
}

async function waitForExtension(proxyStarted) {
  if (proxyStarted) await sleep(EXTENSION_SETTLE_MS);

  const deadline = Date.now() + EXTENSION_WAIT_MS;
  let health = null;
  do {
    health = await getHealth();
    if (isExtensionReady(health)) return health;
    await sleep(EXTENSION_POLL_MS);
  } while (Date.now() < deadline);

  return health;
}

async function stopNativeProxy(health) {
  const pid = Number(health.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    throw new Error('Native proxy did not expose a valid pid; refusing to stop it');
  }

  console.log(`cdp-extension: stopping native proxy (pid ${pid})`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }

  const deadline = Date.now() + PROXY_STOP_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(PROXY_STOP_POLL_MS);
    const current = await getHealth();
    if (!current) return;
    if (current.backend !== 'cdp-native' || Number(current.pid) !== pid) {
      throw new Error(`Port ${PORT} was claimed by another backend while stopping native proxy`);
    }
  }

  throw new Error(`Timed out waiting for native proxy ${pid} to stop`);
}

function isExtensionReady(health) {
  return health?.status === 'ok' &&
    health.backend === 'cdp-extension' &&
    health.connected === true;
}

function getHealth() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, { timeout: 1000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
