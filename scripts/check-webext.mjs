#!/usr/bin/env node
// Ensure the web-access browser-extension proxy is running and report install state.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_SCRIPT = path.join(ROOT, 'scripts', 'webext-proxy.mjs');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const PORT = Number(process.env.WEB_ACCESS_EXT_PROXY_PORT || 3457);
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;

async function main() {
  await ensureProxy();
  const health = await getHealth();
  if (health?.connected) {
    console.log(`webext: ready (${health.extension?.browser || 'browser'} ${health.extension?.version || ''})`);
    process.exit(0);
  }

  console.log('webext: proxy ready, extension not connected');
  console.log('  1. 打开 chrome://extensions 或 edge://extensions，并启用 Developer mode');
  console.log(`  2. 选择 Load unpacked，目录选择：${EXTENSION_DIR}`);
  console.log('  3. 保持该扩展启用；完成这一次安装授权后，web-access 日常使用不再需要 Chrome remote-debugging 授权弹窗');
  console.log(`  4. 重新运行：node "${path.join(ROOT, 'scripts', 'check-webext.mjs')}"`);
  process.exit(1);
}

async function ensureProxy() {
  const health = await getHealth();
  if (health?.status === 'ok') return;

  const logFile = path.join(os.tmpdir(), 'web-access-webext-proxy.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    ...(os.platform() === 'win32' ? { windowsHide: true } : {}),
  });
  child.unref();
  fs.closeSync(logFd);

  for (let i = 0; i < 20; i++) {
    await sleep(300);
    if ((await getHealth())?.status === 'ok') return;
  }
  throw new Error(`webext proxy did not start; see ${logFile}`);
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
