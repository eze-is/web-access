#!/usr/bin/env node
/**
 * CDP Proxy v2
 * 核心改进：事件驱动等待 + 批处理 + Tab 池化
 */

import http from 'http';
import fs from 'fs';

// WebSocket 兼容层（Node.js 22+ 原生，或 ws 模块回退）
let WS;
if (typeof globalThis.WebSocket !== 'undefined') {
  WS = globalThis.WebSocket;
} else {
  try {
    WS = (await import('ws')).default;
  } catch {
    console.error('[CDP Proxy] 需要 Node.js 22+ 或安装 ws 模块');
    process.exit(1);
  }
}

const PORT = process.env.CDP_PROXY_PORT || 3456;
const CDP_PORT = process.env.CDP_PORT || 9222;

let browserWs = null;
const sessions = new Map();
const tabPool = new Map();
const eventListeners = new Map();
let msgId = 1;
const pendingCommands = new Map();

async function ensureBrowserConnection() {
  if (browserWs?.readyState === WS.OPEN) return browserWs;
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const { webSocketDebuggerUrl } = await res.json();
  return new Promise((resolve, reject) => {
    browserWs = new WS(webSocketDebuggerUrl, { perMessageDeflate: false });
    const onOpen = () => { console.log('[CDP] Connected'); resolve(browserWs); };
    const onError = (err) => { console.error('[CDP] WS error:', err.message); reject(err); };
    const onClose = () => { browserWs = null; };
    const onMessage = (event) => {
      const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
      const msg = JSON.parse(raw);
      if (msg.id && pendingCommands.has(msg.id)) {
        pendingCommands.get(msg.id).resolve(msg);
        pendingCommands.delete(msg.id);
      } else if (msg.method && msg.sessionId) {
        handleCDPEvent(msg.sessionId, msg.method, msg.params);
      }
    };
    if (browserWs.on) {
      browserWs.on('open', onOpen);
      browserWs.on('error', onError);
      browserWs.on('close', onClose);
      browserWs.on('message', onMessage);
    } else {
      browserWs.addEventListener('open', onOpen);
      browserWs.addEventListener('error', onError);
      browserWs.addEventListener('close', onClose);
      browserWs.addEventListener('message', onMessage);
    }
  });
}

function handleCDPEvent(sessionId, method, params) {
  const listener = eventListeners.get(sessionId);
  if (!listener) return;
  if (method === 'Page.loadEventFired') {
    listener.loadFired = true;
    checkPageReady(sessionId);
  }
  if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    listener.pendingRequests = Math.max(0, (listener.pendingRequests || 0) - 1);
    checkPageReady(sessionId);
  }
  if (method === 'Network.requestWillBeSent') {
    listener.pendingRequests = (listener.pendingRequests || 0) + 1;
  }
}

function checkPageReady(sessionId) {
  const listener = eventListeners.get(sessionId);
  if (!listener?.loadResolve) return;
  if (listener.loadFired && (listener.pendingRequests || 0) <= 0) {
    clearTimeout(listener.timeout);
    listener.loadResolve({ success: true });
    listener.loadResolve = null;
  }
}

async function waitForPageLoad(sessionId, timeout = 30000) {
  const listener = eventListeners.get(sessionId) || {};
  listener.loadFired = false;
  listener.pendingRequests = 0;
  eventListeners.set(sessionId, listener);
  return new Promise((resolve) => {
    listener.loadResolve = resolve;
    listener.timeout = setTimeout(() => {
      resolve({ success: true, method: 'timeout' });
      listener.loadResolve = null;
    }, timeout);
  });
}

async function sendCommand(method, params = {}, sessionId = null) {
  await ensureBrowserConnection();
  const id = msgId++;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`Command timeout: ${method}`));
    }, 30000);
    pendingCommands.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); } });
    browserWs.send(JSON.stringify(msg));
  });
}

async function attachToTarget(targetId) {
  if (sessions.has(targetId)) {
    sessions.get(targetId).lastUsed = Date.now();
    return sessions.get(targetId).sessionId;
  }
  const result = await sendCommand('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = result.result.sessionId;
  await Promise.all([
    sendCommand('Page.enable', {}, sessionId),
    sendCommand('Network.enable', {}, sessionId),
    sendCommand('Runtime.enable', {}, sessionId),
    sendCommand('DOM.enable', {}, sessionId),
  ]);
  sessions.set(targetId, { sessionId, lastUsed: Date.now() });
  return sessionId;
}

async function executeBatch(targetId, commands) {
  const sessionId = await attachToTarget(targetId);
  const results = [];
  for (const cmd of commands) {
    try {
      let r;
      switch (cmd.action) {
        case 'navigate':
          await sendCommand('Page.navigate', { url: cmd.url }, sessionId);
          if (cmd.waitLoad !== false) r = await waitForPageLoad(sessionId);
          r = { url: cmd.url, loaded: true, ...r };
          break;
        case 'eval':
          const ev = await sendCommand('Runtime.evaluate', {
            expression: cmd.expression, returnByValue: true, awaitPromise: true,
          }, sessionId);
          r = { value: ev.result?.result?.value };
          break;
        case 'click':
          const box = await sendCommand('Runtime.evaluate', {
            expression: `(()=>{const e=document.querySelector('${cmd.selector.replace(/'/g,"\\'")}');if(!e)return null;const rect=e.getBoundingClientRect();return{x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()`,
          }, sessionId);
          if (!box.result?.result?.value) throw new Error(`Not found: ${cmd.selector}`);
          const { x, y } = box.result.result.value;
          await sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
          await sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
          r = { clicked: true };
          break;
        case 'type':
          await sendCommand('Runtime.evaluate', {
            expression: `document.querySelector('${cmd.selector.replace(/'/g,"\\'")}')?.focus()`,
          }, sessionId);
          for (const ch of cmd.text) {
            await sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', text: ch }, sessionId);
            await sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', text: ch }, sessionId);
          }
          r = { typed: true };
          break;
        case 'wait':
          const start = Date.now();
          while (Date.now() - start < (cmd.timeout || 10000)) {
            const found = await sendCommand('Runtime.evaluate', {
              expression: `!!document.querySelector('${cmd.selector.replace(/'/g,"\\'")}')`,
            }, sessionId);
            if (found.result?.result?.value) { r = { found: true }; break; }
            await new Promise(res => setTimeout(res, 100));
          }
          r = r || { found: false };
          break;
        case 'screenshot':
          const shot = await sendCommand('Page.captureScreenshot', { format: 'png' }, sessionId);
          if (cmd.file) {
            await fs.promises.writeFile(cmd.file, Buffer.from(shot.result.data, 'base64'));
            r = { file: cmd.file };
          }
          r = r || { captured: true };
          break;
        case 'scroll':
          const scripts = { top:'window.scrollTo(0,0)', bottom:'window.scrollTo(0,document.body.scrollHeight)', up:'window.scrollBy(0,-window.innerHeight)', down:'window.scrollBy(0,window.innerHeight)' };
          await sendCommand('Runtime.evaluate', { expression: scripts[cmd.direction] || scripts.down }, sessionId);
          r = { scrolled: cmd.direction };
          break;
        default:
          r = { error: `Unknown: ${cmd.action}` };
      }
      results.push({ action: cmd.action, success: true, ...r });
    } catch (err) {
      results.push({ action: cmd.action, success: false, error: err.message });
      if (cmd.stopOnError) break;
    }
  }
  return results;
}

async function getOrCreateTab(url, reuse = true) {
  const domain = new URL(url).hostname;
  if (reuse && tabPool.has(domain)) {
    const targetId = tabPool.get(domain);
    try {
      const sessionId = await attachToTarget(targetId);
      await sendCommand('Page.navigate', { url }, sessionId);
      await waitForPageLoad(sessionId);
      return { targetId, reused: true };
    } catch { tabPool.delete(domain); }
  }
  const result = await sendCommand('Target.createTarget', { url });
  const targetId = result.result.targetId;
  tabPool.set(domain, targetId);
  const sessionId = await attachToTarget(targetId);
  await waitForPageLoad(sessionId);
  return { targetId, reused: false };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  try {
    let body = '';
    if (req.method === 'POST') {
      body = await new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d)); });
    }
    let result;
    switch (path) {
      case '/batch':
      case '/execute': {
        const { target, commands } = JSON.parse(body);
        result = await executeBatch(target, commands);
        break;
      }
      case '/smart-open': {
        result = await getOrCreateTab(url.searchParams.get('url'), url.searchParams.get('reuse') !== 'false');
        break;
      }
      case '/new': {
        const r2 = await sendCommand('Target.createTarget', { url: url.searchParams.get('url') || 'about:blank' });
        const tid = r2.result.targetId;
        const sid = await attachToTarget(tid);
        if (url.searchParams.get('url')) await waitForPageLoad(sid);
        result = { targetId: tid };
        break;
      }
      case '/eval': {
        const sid = await attachToTarget(url.searchParams.get('target'));
        const ev = await sendCommand('Runtime.evaluate', { expression: body, returnByValue: true, awaitPromise: true }, sid);
        result = { value: ev.result?.result?.value };
        break;
      }
      case '/click': {
        const sid = await attachToTarget(url.searchParams.get('target'));
        const box = await sendCommand('Runtime.evaluate', {
          expression: `(()=>{const e=document.querySelector('${body.replace(/'/g,"\\'")}');if(!e)return;const rect=e.getBoundingClientRect();return{x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()`,
        }, sid);
        const { x, y } = box.result.result.value;
        await sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid);
        await sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid);
        result = { clicked: true };
        break;
      }
      case '/screenshot': {
        const sid = await attachToTarget(url.searchParams.get('target'));
        const shot = await sendCommand('Page.captureScreenshot', { format: 'png' }, sid);
        const file = url.searchParams.get('file');
        if (file) {
          await fs.promises.writeFile(file, Buffer.from(shot.result.data, 'base64'));
          result = { file };
        } else {
          result = { base64: shot.result.data };
        }
        break;
      }
      case '/close': {
        await sendCommand('Target.closeTarget', { targetId: url.searchParams.get('target') });
        sessions.delete(url.searchParams.get('target'));
        result = { closed: true };
        break;
      }
      case '/status': {
        result = { connected: browserWs?.readyState === WS.OPEN, sessions: sessions.size, tabPool: tabPool.size };
        break;
      }
      case '/tabs': {
        const r = await sendCommand('Target.getTargets');
        result = { tabs: r.result.targetInfos.filter(t => t.type === 'page').map(t => ({ id: t.targetId, url: t.url, title: t.title })) };
        break;
      }
      default:
        res.statusCode = 404;
        result = { error: 'Not found' };
    }
    res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`[CDP Proxy v2] Running on http://localhost:${PORT}`);
  ensureBrowserConnection().catch(e => console.log('[CDP] Will connect on first request:', e.message));
});

setInterval(() => {
  const now = Date.now();
  for (const [tid, s] of sessions) {
    if (now - s.lastUsed > 10 * 60 * 1000) {
      sendCommand('Target.closeTarget', { targetId: tid }).catch(() => {});
      sessions.delete(tid);
    }
  }
}, 60000);
