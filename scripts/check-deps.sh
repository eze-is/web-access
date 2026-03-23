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

# Chrome 调试端口（9222）— 先检测默认 profile，不行再引导用户
PORT_LISTENING=false
CDP_API_OK=false

# 1. 检测端口是否在监听
if node -e "
const net = require('net');
const s = net.createConnection(9222, '127.0.0.1');
s.on('connect', () => { process.exit(0); });
s.on('error', () => process.exit(1));
setTimeout(() => process.exit(1), 2000);
" 2>/dev/null; then
  PORT_LISTENING=true
fi

# 2. 检测 CDP HTTP API 是否可用
if curl -s --connect-timeout 2 "http://127.0.0.1:9222/json/version" 2>/dev/null | grep -q '"Browser"'; then
  CDP_API_OK=true
fi

if [ "$PORT_LISTENING" = true ]; then
  if [ "$CDP_API_OK" = true ]; then
    echo "chrome: ok (port 9222, full CDP)"
  else
    echo "chrome: ok (port 9222, WebSocket only)"
  fi
elif [ "$PORT_LISTENING" = false ]; then
  echo "chrome: ❌ 端口 9222 未开放"
  echo ""
  echo "  请先在 Chrome 中打开 chrome://inspect/#remote-debugging 并开启 toggle"
  echo "  如果 toggle 卡在 starting，可以关闭 Chrome 后用独立 profile 启动（无登录态但稳定）："
  if [ "$(uname)" = "Darwin" ]; then
    echo "    /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir=\"\$HOME/.chrome-debug-profile\""
  else
    echo "    google-chrome --remote-debugging-port=9222 --user-data-dir=\"\$HOME/.chrome-debug-profile\""
  fi
  exit 1
fi

# CDP Proxy — 检查状态，断开的旧进程直接杀掉重启
HEALTH=$(curl -s --connect-timeout 2 "http://127.0.0.1:3456/health" 2>/dev/null)
if echo "$HEALTH" | grep -q '"connected":true'; then
  echo "proxy: ready"
else
  # 如果有旧 Proxy 在跑但未连接，杀掉它
  if echo "$HEALTH" | grep -q '"ok"'; then
    echo "proxy: stale, restarting..."
    lsof -ti :3456 | xargs kill -9 2>/dev/null
    sleep 1
  else
    echo "proxy: starting..."
  fi
  node ~/.claude/skills/web-access/scripts/cdp-proxy.mjs > /tmp/cdp-proxy.log 2>&1 &
  for i in $(seq 1 15); do
    sleep 1
    curl -s http://localhost:3456/health | grep -q '"connected":true' && echo "proxy: ready" && exit 0
    [ $i -eq 3 ] && echo "⚠️  Chrome 可能有授权弹窗，请点击「允许」后等待连接..."
  done
  echo "❌ 连接超时，请检查 Chrome 调试设置"
  exit 1
fi
