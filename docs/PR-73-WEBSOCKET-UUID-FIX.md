# PR #73 Fix: WebSocket UUID Resolution for Headless Chrome

## Summary

Fix for CDP proxy connection failure when Chrome is started with `--remote-debugging-port` in headless mode.

**PR**: https://github.com/eze-is/web-access/pull/73  
**Status**: Open  
**Author**: ghoenixfang-dot

---

## Problem

When Chrome is started with `--remote-debugging-port`, the `DevToolsActivePort` file is not created. This causes `cdp-proxy.mjs` to fall back to connecting to `/devtools/browser` without a UUID, which fails in headless mode (connection closes immediately with code 1006).

### Root Cause Analysis

1. Chrome started with `--remote-debugging-port=9222` does NOT create `~/.config/google-chrome/DevToolsActivePort`
2. `cdp-proxy.mjs` falls back to scanning ports and finds 9222 open
3. It attempts WebSocket connection to `ws://127.0.0.1:9222/devtools/browser` (no UUID)
4. Headless Chrome's browser-level endpoint rejects this with immediate close (1006)
5. User sees: `proxy: connecting... ❌ 连接超时，请检查 Chrome 调试设置`

### Verified Behavior

| Connection Type | URL | Result |
|-----------------|-----|--------|
| Browser-level (no UUID) | `ws://127.0.0.1:9222/devtools/browser` | Closes immediately (1006) |
| With UUID | `ws://127.0.0.1:9222/devtools/browser/{uuid}` | Works |

---

## Solution

After detecting an open Chrome debugging port via TCP, query the Chrome HTTP API at `http://127.0.0.1:{port}/json/version` to get the actual `webSocketDebuggerUrl` containing the UUID. Use this UUID path for the WebSocket connection.

### Changes

**File**: `scripts/cdp-proxy.mjs`

1. Added `getWsPathFromHttpApi(port)` function:
   - Queries `http://127.0.0.1:{port}/json/version`
   - Extracts UUID from `webSocketDebuggerUrl`
   - Returns path like `/devtools/browser/{uuid}`

2. Modified `discoverChromePort()`:
   - After finding open port via TCP, calls `getWsPathFromHttpApi()` to get UUID
   - Falls back to null UUID only if HTTP API fails

### Code Diff

```diff
  // 2. 扫描常用端口
  const commonPorts = [9222, 9229, 9333];
  for (const port of commonPorts) {
    const ok = await checkPort(port);
    if (ok) {
      console.log(`[CDP Proxy] 扫描发现 Chrome 调试端口: ${port}`);
+     // 尝试通过 HTTP API 获取 WebSocket 路径（含 UUID）
+     const wsPath = await getWsPathFromHttpApi(port);
+     if (wsPath) {
+       console.log(`[CDP Proxy] 通过 HTTP API 获取到 wsPath: ${wsPath}`);
+       return { port, wsPath };
+     }
      return { port, wsPath: null };
    }
  }

  return null;
}

// 通过 HTTP API 获取 Chrome WebSocket URL（含 UUID）
async function getWsPathFromHttpApi(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!res.ok) return null;
    const json = await res.json();
    const wsUrl = json.webSocketDebuggerUrl;
    if (!wsUrl) return null;
    // 提取路径部分，如 /devtools/browser/xxx-xxx
    const match = wsUrl.match(/\/devtools\/browser\/[^\/]+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}
```

---

## Test Results

### Before Fix

```
$ node scripts/check-deps.mjs
node: ok (v24.14.0)
chrome: ok (port 9222)
proxy: connecting...
WARNING: Chrome may have authorization popup, please click Allow and wait...
ERROR: Connection timeout, please check Chrome debug settings
```

### After Fix

```
$ node scripts/check-deps.mjs
node: ok (v24.14.0)
chrome: ok (port 9222)
proxy: ready
```

---

## Related Files

- `scripts/cdp-proxy.mjs` - Main fix location
- `scripts/check-deps.mjs` - Verification script

---

## Environment

- **Chrome**: 147.0.7727.137 (headless mode)
- **Node.js**: v24.14.0
- **Platform**: Linux (Ubuntu 24.04)
- **Chrome flags**: `--headless=new --no-sandbox --disable-gpu --remote-debugging-port=9222`

---

## History

- **2026-05-03**: Fix submitted via PR #73
- **2026-05-03**: Problem identified and root cause analyzed
