#!/usr/bin/env bash
# 环境检查 + 确保 CDP Proxy 就绪

# Node.js
if command -v node &>/dev/null; then
  NODE_VER=$(node --version 2>/dev/null)
  NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 22 ] 2>/dev/null; then
    echo "node: ok ($NODE_VER)"
  else
    echo "node: warn ($NODE_VER, 建议升级到 22+)"
  fi
else
  echo "node: missing — 请安装 Node.js 22+"
  exit 1
fi

# Chrome 调试端口 — 先读 DevToolsActivePort，再回退常见端口
if ! CHROME_PORT=$(node -e "
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

function checkPort(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, '127.0.0.1');
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

function activePortFiles() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || '';
  switch (process.platform) {
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

(async () => {
  for (const filePath of activePortFiles()) {
    try {
      const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\\r?\\n/).filter(Boolean);
      const port = parseInt(lines[0], 10);
      if (port > 0 && port < 65536 && await checkPort(port)) {
        console.log(port);
        process.exit(0);
      }
    } catch (_) {}
  }

  for (const port of [9222, 9229, 9333]) {
    if (await checkPort(port)) {
      console.log(port);
      process.exit(0);
    }
  }

  process.exit(1);
})();
" 2>/dev/null); then
  echo "chrome: not connected — 请打开 chrome://inspect/#remote-debugging 并勾选 Allow remote debugging"
  exit 1
fi
echo "chrome: ok (port $CHROME_PORT)"

# CDP Proxy — 已运行则跳过，未运行则启动并等待连接
HEALTH=$(curl -s --connect-timeout 2 "http://127.0.0.1:3456/health" 2>/dev/null)
if echo "$HEALTH" | grep -q '"connected":true'; then
  echo "proxy: ready"
else
  if ! echo "$HEALTH" | grep -q '"ok"'; then
    echo "proxy: starting..."
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    node "$SCRIPT_DIR/cdp-proxy.mjs" > /tmp/cdp-proxy.log 2>&1 &
  fi
  PROXY_HINT_SHOWN=0
  for i in $(seq 1 30); do
    sleep 1
    HEALTH=$(curl -s --connect-timeout 2 "http://127.0.0.1:3456/health?reconnect=1" 2>/dev/null)
    echo "$HEALTH" | grep -q '"connected":true' && echo "proxy: ready" && exit 0
    if [ $PROXY_HINT_SHOWN -eq 0 ] && echo "$HEALTH" | grep -q '"ok"'; then
      echo "proxy: waiting for Chrome authorization..."
      PROXY_HINT_SHOWN=1
    fi
    [ $i -eq 3 ] && echo "⚠️  Chrome 可能有授权弹窗，请点击「允许」后等待连接..."
  done
  echo "❌ 连接超时，请检查 Chrome 调试设置"
  exit 1
fi
