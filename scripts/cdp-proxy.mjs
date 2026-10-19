#!/usr/bin/env node
// CDP Proxy - 通过 HTTP API 操控用户日常浏览器（任意 Chromium 内核浏览器，按数据目录选定）
// 要求：浏览器已开启 remote debugging（chrome://inspect/#remote-debugging toggle，Edge 为 edge://）
// Node.js 22+（使用原生 WebSocket）

import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createCdpConnection } from './cdp-connection.mjs';
import { selectBrowser, explainUnavailable } from './browser-discovery.mjs';
import { createPageFrames, FrameError } from './page-frames.mjs';

// --- 解析命令行 --browser 参数（本次启动用哪个浏览器）---
function parseBrowserArg() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--browser' && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith('--browser=')) return argv[i].slice('--browser='.length);
  }
  return null;
}
const BROWSER_OVERRIDE = parseBrowserArg();

const PORT = parseInt(process.env.CDP_PROXY_PORT || '3456');
const sessions = new Map(); // targetId -> sessionId
const managedTabs = new Map(); // targetId -> { lastAccessed: number }
const TAB_IDLE_TIMEOUT = parseInt(process.env.CDP_TAB_IDLE_TIMEOUT || '900000'); // 15 min default
const CLEANUP_INTERVAL = 60000; // sweep every 60s
const INSTANCE_ID = randomUUID();
const STARTED_AT = new Date().toISOString();
const RUNNING_REVISION = createHash('sha256')
  .update(fs.readFileSync(new URL(import.meta.url)))
  .update(fs.readFileSync(new URL('./cdp-connection.mjs', import.meta.url)))
  .digest('hex').slice(0, 12);
let activeRequests = 0;
let maintenance = false;
let cleanupTimer = null;
let shutdownPromise = null;

function lifecycleLog(message) {
  console.log(`[${new Date().toISOString()} pid=${process.pid} instance=${INSTANCE_ID}] [CDP Proxy] ${message}`);
}

// --- WebSocket 兼容层 ---
let WS;
if (typeof globalThis.WebSocket !== 'undefined') {
  // Node 22+ 原生 WebSocket（浏览器兼容 API）
  WS = globalThis.WebSocket;
} else {
  // 回退到 ws 模块
  try {
    WS = (await import('ws')).default;
  } catch {
    console.error('[CDP Proxy] 错误：Node.js 版本 < 22 且未安装 ws 模块');
    console.error('  解决方案：升级到 Node.js 22+ 或执行 npm install -g ws');
    process.exit(1);
  }
}

// proxy 启动时连接到的浏览器（用于 /health 暴露给 check-deps 与维护命令比较）
let connectedBrowser = null; // { id: 数据目录路径, label: 显示名, source }

// pin 首次成功连接的浏览器身份（数据目录）。重连时只接受同一身份，避免悄悄换到别的浏览器。
let pinnedBrowser = null; // { id, label }

// --- 发现浏览器调试端口 ---
// 决策完全委派给 browser-discovery.selectBrowser；此处只做 pin 校验、日志和返回结构包装。
// 不可用一律抛错（由下一次请求重试），不扫描固定端口、不换浏览器。
async function discoverChromePort() {
  const result = await selectBrowser(BROWSER_OVERRIDE);
  if (result.kind === 'config-error') throw new Error(result.message);
  if (result.kind === 'unset') {
    throw new Error('尚未设置浏览器。请先运行 node scripts/check-deps.mjs 完成首次配置（写入 WEB_ACCESS_BROWSER），或启动时指定 --browser <数据目录路径>。');
  }
  if (result.kind === 'unavailable') {
    const steps = explainUnavailable(result).join(' ');
    const switchHint = pinnedBrowser ? '若想换成其他浏览器，请等共享任务完成，通过 proxy-maintenance.mjs stop 停止后再指定 --browser。' : '';
    throw new Error(`${steps} ${switchHint}`.trim());
  }
  if (pinnedBrowser && pinnedBrowser.id !== result.browser.id) {
    throw new Error(
      `本次连接的浏览器已经是 ${pinnedBrowser.label}（${pinnedBrowser.id}），不会自动切到 ${result.browser.label}（${result.browser.id}）。` +
      `如果想换浏览器，请等共享任务完成，通过 proxy-maintenance.mjs stop 停止后再指定 --browser。`
    );
  }
  connectedBrowser = { id: result.browser.id, label: result.browser.label, source: result.source };
  const tag = result.source === 'override' ? '[--browser 指定]' : '[config.env 偏好]';
  console.log(`[CDP Proxy] 选用 ${result.browser.label}（${result.browser.id}，端口 ${result.browser.port}${result.browser.wsPath ? '，带 wsPath' : ''}）${tag}`);
  return { port: result.browser.port, wsPath: result.browser.wsPath };
}

function getWebSocketUrl(port, wsPath) {
  if (wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
  return `ws://127.0.0.1:${port}/devtools/browser`;
}

// --- 连接唯一所有者：发现、握手和 CDP 请求共用同一生命周期 ---
let chromePort = null;
const connection = createCdpConnection({
  WebSocketImpl: WS,
  discoverUrl: async () => {
    const discovered = await discoverChromePort();
    chromePort = discovered.port;
    return getWebSocketUrl(discovered.port, discovered.wsPath);
  },
  onConnect: () => {
    pinnedBrowser = { id: connectedBrowser.id, label: connectedBrowser.label };
    lifecycleLog(`已连接浏览器 (端口 ${chromePort})`);
  },
  onDisconnect: (error) => {
    chromePort = null;
    sessions.clear();
    managedTabs.clear();
    portGuardedSessions.clear();
    lifecycleLog(`连接已失效：${error.message}`);
  },
  onDiagnostic: (error) => lifecycleLog(`连接诊断：${error.message}`),
  onEvent: (msg) => {
    if (msg.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = msg.params;
      sessions.set(targetInfo.targetId, sessionId);
    }
    // 标签页关闭、跨进程 iframe 换进程或被移除时，浏览器解除对应 session；从缓存删除，下次使用时重新 attach。
    if (msg.method === 'Target.detachedFromTarget') {
      const { sessionId, targetId } = msg.params;
      for (const [id, sid] of sessions) {
        if (sid === sessionId && (!targetId || id === targetId)) sessions.delete(id);
      }
      portGuardedSessions.delete(sessionId);
    }
    if (msg.method === 'Fetch.requestPaused') {
      const { requestId, sessionId: sid } = msg.params;
      sendCDP('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }, sid)
        .catch(error => lifecycleLog(`端口探测拦截失败：${error.message}`));
    }
  },
});

const connect = () => connection.connect();
const sendCDP = (method, params = {}, sessionId = null) => connection.send(method, params, sessionId);

// 已启用端口拦截的 session 集合（避免重复启用）
const portGuardedSessions = new Set();

async function ensureSession(targetId) {
  if (sessions.has(targetId)) return sessions.get(targetId);
  const resp = await sendCDP('Target.attachToTarget', { targetId, flatten: true });
  if (resp.result?.sessionId) {
    const sid = resp.result.sessionId;
    sessions.set(targetId, sid);
    // 启用调试端口探测拦截
    await enablePortGuard(sid);
    return sid;
  }
  throw new Error('attach 失败: ' + JSON.stringify(resp.error));
}

// 页面中的 iframe（列举、执行、坐标点击路由）；跨进程 iframe 的子 session 同样经 ensureSession 进入缓存
const pageFrames = createPageFrames({ send: (...args) => sendCDP(...args), ensureSession });

// 拦截页面对 Chrome 调试端口的探测（反风控）
// 只拦截 127.0.0.1:{chromePort} 的请求，不影响其他任何本地服务
async function enablePortGuard(sessionId) {
  if (!chromePort || portGuardedSessions.has(sessionId)) return;
  try {
    await sendCDP('Fetch.enable', {
      patterns: [
        { urlPattern: `http://127.0.0.1:${chromePort}/*`, requestStage: 'Request' },
        { urlPattern: `http://localhost:${chromePort}/*`, requestStage: 'Request' },
      ]
    }, sessionId);
    portGuardedSessions.add(sessionId);
  } catch { /* Fetch 域启用失败不影响主流程 */ }
}

// --- 闲置 Tab 自动清理 ---
function touchTab(targetId) {
  const entry = managedTabs.get(targetId);
  if (entry) entry.lastAccessed = Date.now();
}

async function cleanupIdleTabs() {
  if (!connection.connected) return;
  const now = Date.now();
  for (const [targetId, info] of managedTabs) {
    if (now - info.lastAccessed < TAB_IDLE_TIMEOUT) continue;
    try { await sendCDP('Target.closeTarget', { targetId }); } catch { /* tab may already be closed */ }
    sessions.delete(targetId);
    managedTabs.delete(targetId);
    console.log(`[CDP Proxy] Auto-closed idle tab: ${targetId}`);
  }
}

async function closeAllManagedTabs() {
  if (!connection.connected) return;
  const targets = [...managedTabs.keys()];
  for (const targetId of targets) {
    try { await sendCDP('Target.closeTarget', { targetId }); } catch { /* ignore */ }
    sessions.delete(targetId);
    managedTabs.delete(targetId);
  }
  if (targets.length) console.log(`[CDP Proxy] Shutdown: closed ${targets.length} managed tab(s)`);
}

// --- 等待页面加载 ---
async function waitForLoad(
  sessionId,
  timeoutMs = 15000,
  { requireNonBlank = false, acceptInteractive = false } = {},
) {
  // 启用 Page 域
  await sendCDP('Page.enable', {}, sessionId);

  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearInterval(checkInterval);
      resolve(result);
    };

    const timer = setTimeout(() => done('timeout'), timeoutMs);
    const checkInterval = setInterval(async () => {
      try {
        const resp = await sendCDP('Runtime.evaluate', {
          expression: 'JSON.stringify({ ready: document.readyState, url: location.href })',
          returnByValue: true,
        }, sessionId);
        const value = resp.result?.result?.value;
        const state = typeof value === 'string' ? JSON.parse(value) : null;
        const ready = state?.ready === 'complete' || (acceptInteractive && state?.ready === 'interactive');
        if (ready && (!requireNonBlank || state.url !== 'about:blank')) {
          done('complete');
        }
      } catch { /* 忽略 */ }
    }, 500);
  });
}

// --- 读取 POST body ---
async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

// --- HTTP API ---
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  const q = Object.fromEntries(parsed.searchParams);
  if (q.target) touchTab(q.target);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  let operationActive = false;
  try {
    // /health 不需要连接浏览器
    if (pathname === '/health') {
      const connected = connection.connected;
      res.end(JSON.stringify({
        status: 'ok',
        connected,
        browser: connectedBrowser,
        sessions: sessions.size,
        managedTabs: managedTabs.size,
        chromePort,
        pid: process.pid,
        instanceId: INSTANCE_ID,
        startedAt: STARTED_AT,
        runningRevision: RUNNING_REVISION,
        connectionState: connection.state,
        connectionAttempts: connection.attemptCount,
        pendingCommands: connection.pendingCount,
        activeRequests,
        maintenance,
      }));
      return;
    }

    // 维护由明确的本机命令触发；普通浏览器页面不能请求关闭共享服务。
    if (pathname === '/shutdown') {
      if (req.method !== 'POST' || req.headers.origin) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: '请使用本机维护命令' }));
        return;
      }
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '维护请求需要 instanceId JSON' }));
        return;
      }
      if (body?.instanceId !== INSTANCE_ID) {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: '服务实例已变化，请重新检查', instanceId: INSTANCE_ID }));
        return;
      }
      if (!maintenance && (activeRequests > 0 || managedTabs.size > 0 || connection.pendingCount > 0 ||
          connection.state === 'discovering' || connection.state === 'connecting')) {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: 'busy', activeRequests, managedTabs: managedTabs.size, pendingCommands: connection.pendingCount }));
        return;
      }
      maintenance = true;
      res.once('finish', () => { void shutdown('维护命令'); });
      res.statusCode = 202;
      res.end(JSON.stringify({ status: 'stopping', instanceId: INSTANCE_ID }));
      return;
    }

    if (maintenance) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: '服务正在维护，请稍后重试' }));
      return;
    }
    activeRequests++;
    operationActive = true;

    await connect();

    // GET /targets - 列出所有页面
    if (pathname === '/targets') {
      const resp = await sendCDP('Target.getTargets');
      const pages = resp.result.targetInfos.filter(t => t.type === 'page');
      res.end(JSON.stringify(pages, null, 2));
    }

    // POST /new (body=URL) - 创建新后台 tab
    else if (pathname === '/new') {
      if (req.method !== 'POST') {
        res.statusCode = 400;
        res.end(JSON.stringify({
          error: 'v2.5.3 起 /new 改为 POST 传 URL（避免目标 URL 含 query 时被错误切分）',
          migration: 'references/migration-2.5.3.md',
          example: "curl -X POST --data-raw 'https://example.com' http://localhost:3456/new",
        }));
        return;
      }
      const body = (await readBody(req)).trim();
      const targetUrl = body || 'about:blank';
      // 先创建空白页并完成 attach，再显式导航。Target.createTarget({ url }) 会先暴露
      // readyState=complete 的 about:blank，导致慢页面在真正开始加载前被误判为完成。
      const resp = await sendCDP('Target.createTarget', { url: 'about:blank', background: true });
      const targetId = resp.result.targetId;
      managedTabs.set(targetId, { lastAccessed: Date.now() });

      // 等待页面加载
      if (targetUrl !== 'about:blank') {
        try {
          const sid = await ensureSession(targetId);
          await sendCDP('Page.navigate', { url: targetUrl }, sid);
          await waitForLoad(sid, 15000, { requireNonBlank: true, acceptInteractive: true });
        } catch { /* 非致命，继续 */ }
      }

      res.end(JSON.stringify({ targetId }));
    }

    // GET /close?target=xxx - 关闭 tab
    else if (pathname === '/close') {
      const resp = await sendCDP('Target.closeTarget', { targetId: q.target });
      sessions.delete(q.target);
      managedTabs.delete(q.target);
      res.end(JSON.stringify(resp.result));
    }

    // POST /navigate?target=xxx (body=URL) - 导航（自动等待加载）
    else if (pathname === '/navigate') {
      if (req.method !== 'POST') {
        res.statusCode = 400;
        res.end(JSON.stringify({
          error: 'v2.5.3 起 /navigate 改为 POST 传 URL（避免目标 URL 含 query 时被错误切分）',
          migration: 'references/migration-2.5.3.md',
          example: "curl -X POST --data-raw 'https://example.com' 'http://localhost:3456/navigate?target=ID'",
        }));
        return;
      }
      const targetUrl = (await readBody(req)).trim();
      const sid = await ensureSession(q.target);
      const resp = await sendCDP('Page.navigate', { url: targetUrl }, sid);

      // 等待页面加载完成
      await waitForLoad(sid);

      res.end(JSON.stringify(resp.result));
    }

    // GET /back?target=xxx - 后退
    else if (pathname === '/back') {
      const sid = await ensureSession(q.target);
      await sendCDP('Runtime.evaluate', { expression: 'history.back()' }, sid);
      await waitForLoad(sid);
      res.end(JSON.stringify({ ok: true }));
    }

    // GET /frames?target=xxx - 列出页面主文档中的 iframe（frameId、网址、是否跨进程与定位线索）
    else if (pathname === '/frames') {
      if (!q.target) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 target' }));
        return;
      }
      res.end(JSON.stringify(await pageFrames.listFrames(q.target), null, 2));
    }

    // POST /eval?target=xxx[&frame=frameId] - 执行 JS；带 frame 时在该 iframe 中执行（frameId 取自 /frames）
    else if (pathname === '/eval') {
      let sid;
      let contextId;
      if (q.frame !== undefined) ({ sessionId: sid, contextId } = await pageFrames.frameContext(q.target, q.frame));
      else sid = await ensureSession(q.target);
      const body = await readBody(req);
      const expr = body || q.expr || 'document.title';
      const resp = await sendCDP('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
        ...(contextId ? { contextId } : {}),
      }, sid);
      // 带 frame 时如实报告 CDP 协议错误；不带 frame 时保留原有协议错误处理方式。
      if (contextId && resp.error) throw new Error('Runtime.evaluate: ' + resp.error.message);
      // 异常也可能带 result.value（returnByValue 会把 Error 序列化成 {}），必须先判断异常。
      if (resp.result?.exceptionDetails) {
        const { exception, text } = resp.result.exceptionDetails;
        const error = exception?.description ||
          (exception && Object.hasOwn(exception, 'value') ? String(exception.value) : text);
        res.statusCode = 400;
        res.end(JSON.stringify({ error }));
      } else if (resp.result?.result?.value !== undefined) {
        res.end(JSON.stringify({ value: resp.result.result.value }));
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // GET /clickXY?target=xxx&x=120&y=90 - 按视口坐标真实鼠标点击；逐层进入命中的 iframe（跨进程的换算坐标后发给其子 session），不激活标签页
    // clicked 只表示鼠标事件已发出；坐标不在视口内时 400，不发事件
    else if (pathname === '/clickXY') {
      const x = Number(q.x);
      const y = Number(q.y);
      if (!q.target || !q.x?.trim() || !q.y?.trim() || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 target，以及有限的非负 x、y 视口坐标' }));
        return;
      }
      const route = await pageFrames.routePoint(q.target, x, y);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        const resp = await sendCDP('Input.dispatchMouseEvent', {
          type, x: route.x, y: route.y,
          button: type === 'mouseMoved' ? 'none' : 'left',
          buttons: type === 'mousePressed' ? 1 : 0,
          clickCount: type === 'mouseMoved' ? 0 : 1,
        }, route.sessionId);
        if (resp.error) throw new Error('Input.dispatchMouseEvent: ' + resp.error.message);
      }
      res.end(JSON.stringify({
        clicked: true, x, y,
        ...(route.frameId ? { frameId: route.frameId, crossProcess: route.crossProcess, depth: route.depth } : {}),
      }));
    }

    // POST /click?target=xxx - 点击（body 为 CSS 选择器）
    // POST /click?target=xxx — JS 层面点击（简单快速，覆盖大多数场景）
    else if (pathname === '/click') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      const selectorJson = JSON.stringify(selector);
      const js = `(() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: '未找到元素: ' + ${selectorJson} };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { clicked: true, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`;
      const resp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      if (resp.result?.result?.value) {
        const val = resp.result.result.value;
        if (val.error) {
          res.statusCode = 400;
          res.end(JSON.stringify(val));
        } else {
          res.end(JSON.stringify(val));
        }
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // POST /clickAt?target=xxx — CDP 浏览器级真实鼠标点击（算用户手势，能触发文件对话框、绕过反自动化检测）
    else if (pathname === '/clickAt') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      const selectorJson = JSON.stringify(selector);
      const js = `(() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: '未找到元素: ' + ${selectorJson} };
        el.scrollIntoView({ block: 'center' });
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`;
      const coordResp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      const coord = coordResp.result?.result?.value;
      if (!coord || coord.error) {
        res.statusCode = 400;
        res.end(JSON.stringify(coord || coordResp.result));
        return;
      }
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', clickCount: 1
      }, sid);
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', clickCount: 1
      }, sid);
      res.end(JSON.stringify({ clicked: true, x: coord.x, y: coord.y, tag: coord.tag, text: coord.text }));
    }

    // POST /setFiles?target=xxx — 给 file input 设置本地文件（绕过文件对话框）
    // body: JSON { "selector": "input[type=file]", "files": ["/path/to/file1.png", "/path/to/file2.png"] }
    else if (pathname === '/setFiles') {
      const sid = await ensureSession(q.target);
      const body = JSON.parse(await readBody(req));
      if (!body.selector || !body.files) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 selector 和 files 字段' }));
        return;
      }
      // 获取 DOM 节点
      await sendCDP('DOM.enable', {}, sid);
      const doc = await sendCDP('DOM.getDocument', {}, sid);
      const node = await sendCDP('DOM.querySelector', {
        nodeId: doc.result.root.nodeId,
        selector: body.selector
      }, sid);
      if (!node.result?.nodeId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '未找到元素: ' + body.selector }));
        return;
      }
      // 设置文件
      await sendCDP('DOM.setFileInputFiles', {
        nodeId: node.result.nodeId,
        files: body.files
      }, sid);
      res.end(JSON.stringify({ success: true, files: body.files.length }));
    }

    // GET /scroll?target=xxx&y=3000 - 滚动
    else if (pathname === '/scroll') {
      const sid = await ensureSession(q.target);
      const y = parseInt(q.y || '3000');
      const direction = q.direction || 'down'; // down | up | top | bottom
      let js;
      if (direction === 'top') {
        js = 'window.scrollTo(0, 0); "scrolled to top"';
      } else if (direction === 'bottom') {
        js = 'window.scrollTo(0, document.body.scrollHeight); "scrolled to bottom"';
      } else if (direction === 'up') {
        js = `window.scrollBy(0, -${Math.abs(y)}); "scrolled up ${Math.abs(y)}px"`;
      } else {
        js = `window.scrollBy(0, ${Math.abs(y)}); "scrolled down ${Math.abs(y)}px"`;
      }
      const resp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
      }, sid);
      // 等待懒加载触发
      await new Promise(r => setTimeout(r, 800));
      res.end(JSON.stringify({ value: resp.result?.result?.value }));
    }

    // GET /screenshot?target=xxx&file=/tmp/x.png - 截图
    else if (pathname === '/screenshot') {
      const sid = await ensureSession(q.target);
      const format = q.format || 'png';
      const resp = await sendCDP('Page.captureScreenshot', {
        format,
        quality: format === 'jpeg' ? 80 : undefined,
      }, sid);
      if (q.file) {
        fs.writeFileSync(q.file, Buffer.from(resp.result.data, 'base64'));
        res.end(JSON.stringify({ saved: q.file }));
      } else {
        res.setHeader('Content-Type', 'image/' + format);
        res.end(Buffer.from(resp.result.data, 'base64'));
      }
    }

    // GET /info?target=xxx - 获取页面信息
    else if (pathname === '/info') {
      const sid = await ensureSession(q.target);
      const resp = await sendCDP('Runtime.evaluate', {
        expression: 'JSON.stringify({title: document.title, url: location.href, ready: document.readyState})',
        returnByValue: true,
      }, sid);
      res.end(resp.result?.result?.value || '{}');
    }

    else {
      res.statusCode = 404;
      res.end(JSON.stringify({
        error: '未知端点',
        endpoints: {
          '/health': 'GET - 健康检查',
          '/targets': 'GET - 列出所有页面 tab',
          '/new': 'POST body=URL - 创建新后台 tab（自动等待加载）',
          '/close?target=': 'GET - 关闭 tab',
          '/navigate?target=': 'POST body=URL - 导航（自动等待加载）',
          '/back?target=': 'GET - 后退',
          '/info?target=': 'GET - 页面标题/URL/状态',
          '/frames?target=': 'GET - 列出页面中的 iframe（frameId、网址、是否跨进程）',
          '/eval?target=&frame=': 'POST body=JS表达式 - 执行 JS（frame 可选，取自 /frames）',
          '/click?target=': 'POST body=CSS选择器 - 点击元素',
          '/clickAt?target=': 'POST body=CSS选择器 - 真实鼠标点击',
          '/clickXY?target=&x=&y=': 'GET - 按视口坐标真实鼠标点击（可点中跨进程 iframe）',
          '/setFiles?target=': 'POST body=JSON - 设置文件输入',
          '/scroll?target=&y=&direction=': 'GET - 滚动页面',
          '/screenshot?target=&file=': 'GET - 截图',
        },
      }));
    }
  } catch (e) {
    res.statusCode = e instanceof FrameError ? 400 : 500;
    res.end(JSON.stringify({ error: e.message }));
  } finally {
    // 客户端断开不会取消浏览器动作；以 handler 完成结算，避免维护误停后台操作。
    if (operationActive) activeRequests--;
  }
});

// 服务端口的原子绑定决定唯一实例，不用先探测再绑定的竞态窗口。
async function main() {
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      let existing;
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) existing = await response.json();
      } catch { /* 无法确认占用者时明确失败，不连接浏览器。 */ }
      if (existing?.status === 'ok') {
        lifecycleLog(`复用端口 ${PORT} 的已有实例，本启动进程退出`);
        process.exit(0);
      }
    }
    throw error;
  }
  lifecycleLog(`运行在 http://127.0.0.1:${PORT}，revision=${RUNNING_REVISION}`);
  cleanupTimer = setInterval(cleanupIdleTabs, CLEANUP_INTERVAL);
  cleanupTimer.unref();
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  connect().catch(error => lifecycleLog(`初始连接失败：${error.message}（下一次请求可以重试）`));
}

function shutdown(reason) {
  if (shutdownPromise) return shutdownPromise;
  maintenance = true;
  // 先发布整次退出操作，重复维护命令共用同一个结果。
  shutdownPromise = Promise.resolve().then(async () => {
    lifecycleLog(`${reason}，正在退出`);
    clearInterval(cleanupTimer);
    await closeAllManagedTabs();
    connection.close();
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    process.exit(0);
  }).catch(error => {
    lifecycleLog(`退出失败：${error.message}`);
    process.exit(1);
  });
  return shutdownPromise;
}

// 防止未捕获异常导致进程崩溃
process.on('uncaughtException', (e) => {
  console.error('[CDP Proxy] 未捕获异常:', e.message);
});
process.on('unhandledRejection', (e) => {
  console.error('[CDP Proxy] 未处理拒绝:', e?.message || e);
});

main().catch(error => { lifecycleLog(`启动失败：${error.message}`); process.exit(1); });
