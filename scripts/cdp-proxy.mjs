#!/usr/bin/env node

// CDP Proxy - éè¿ HTTP API ææ§ç¨æ·æ¥å¸¸æµè§å¨ï¼Chrome / Edge / Chromium ç­ï¼

// è¦æ±ï¼æµè§å¨å·²å¼å¯ remote debuggingï¼chrome://inspect#remote-debugging toggleï¼

// Node.js 22+ï¼ä½¿ç¨åç WebSocketï¼



import http from 'node:http';

import { URL } from 'node:url';

import fs from 'node:fs';

import path from 'node:path';

import os from 'node:os';

import net from 'node:net';

import { selectBrowser, findFallbackPort } from './browser-discovery.mjs';



// --- è§£æå½ä»¤è¡ --browser åæ°ï¼æ¬æ¬¡å¯å¨ç¨åªä¸ªæµè§å¨ï¼---

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

let ws = null;

let cmdId = 0;

const pending = new Map(); // id -> {resolve, timer}

const sessions = new Map(); // targetId -> sessionId

const managedTabs = new Map(); // targetId -> { lastAccessed: number }

const TAB_IDLE_TIMEOUT = parseInt(process.env.CDP_TAB_IDLE_TIMEOUT || '900000'); // 15 min default

const CLEANUP_INTERVAL = 60000; // sweep every 60s



// --- WebSocket å¼å®¹å± ---

let WS;

if (typeof globalThis.WebSocket !== 'undefined') {

  // Node 22+ åç WebSocketï¼æµè§å¨å¼å®¹ APIï¼

  WS = globalThis.WebSocket;

} else {

  // åéå° ws æ¨¡å

  try {

    WS = (await import('ws')).default;

  } catch {

    console.error('[CDP Proxy] éè¯¯ï¼Node.js çæ¬ < 22 ä¸æªå®è£ ws æ¨¡å');

    console.error('  è§£å³æ¹æ¡ï¼åçº§å° Node.js 22+ ææ§è¡ npm install -g ws');

    process.exit(1);

  }

}



// proxy å¯å¨æ¶è¿æ¥å°çæµè§å¨ï¼ç¨äº /health æ´é²ç» check-deps æ¯è¾ï¼

let connectedBrowser = null; // { id, label, source }



// pin é¦æ¬¡æåè¿æ¥çæµè§å¨ idãéè¿æ¶åªæ¥ååä¸ idï¼é¿åææéçº§å°å«çæµè§å¨ã

let pinnedBrowserId = null;



// --- èªå¨åç°æµè§å¨è°è¯ç«¯å£ ---

// å³ç­å®å¨å§æ´¾ç» browser-discovery.selectBrowserï¼æ­¤å¤åªåæ¥å¿åè¿åç»æåè£ã

async function discoverChromePort() {

  const result = await selectBrowser(BROWSER_OVERRIDE);

  if (result.kind === 'ok') {

    if (pinnedBrowserId && pinnedBrowserId !== result.browser.id) {

      throw new Error(

        `æ¬æ¬¡è¿æ¥çæµè§å¨å·²ç»æ¯ ${pinnedBrowserId}ï¼ä¸ä¼èªå¨åå° ${result.browser.id}ã` +

        `å¦ææ³æ¢æ ${result.browser.id}ï¼è¯·åå¨ç»ç«¯è¿è¡ pkill -f cdp-proxy.mjs éç½®ã`

      );

    }

    pinnedBrowserId = result.browser.id;

    connectedBrowser = { id: result.browser.id, label: result.browser.label, source: result.source };

    const tag = result.source === 'override' ? '[--browser æå®]' : '[config.env åå¥½]';

    console.log(`[CDP Proxy] éç¨ ${result.browser.label} (ç«¯å£ ${result.browser.port}${result.browser.wsPath ? 'ï¼å¸¦ wsPath' : ''}) ${tag}`);

    return { port: result.browser.port, wsPath: result.browser.wsPath };

  }

  // mismatchï¼ææ¾å¼åå¥½ä½æªæ£æµå° ââ ç¡¬éï¼ç»ä¸éçº§

  if (result.kind === 'mismatch') {

    const expected = result.override || result.configured;

    const src = result.source === 'override' ? 'æ¬æ¬¡æå®' : 'é»è®¤åå¥½';

    throw new Error(

      `${src}çæµè§å¨æ¯ "${expected}"ï¼ä½æ²¡è¿ä¸ãAgent å¤çé¡ºåºï¼` +

      `(1) åç¨ç³»ç»å½ä»¤æå¼ ${expected}ï¼æå¹³å°éæ©ï¼å¦ macOS ç open -aï¼ï¼ç¨ç­åéè¯è¯·æ±ï¼` +

      `(2) è¥ä»å¤±è´¥ï¼è¯´æè¿ç¨è°è¯å¼å³æ²¡å¯ç¨ ââ åç¥ç¨æ·å¨å°åæ è®¿é® ${expected}://inspect/#remote-debugging å¾é "Allow remote debugging for this browser instance"ã`

    );

  }

  // å·² pin è¿æµè§å¨ï¼å¦é¦æ¬¡è¿ä¸ edge å edge éåºï¼ï¼æç»ä»»ä½ fallback

  if (pinnedBrowserId) {

    throw new Error(

      `æ¬æ¬¡è¿æ¥çæµè§å¨æ¯ ${pinnedBrowserId}ï¼ä½ç°å¨æ²¡è¿ä¸ãAgent å¤çé¡ºåºï¼` +

      `(1) åç¨ç³»ç»å½ä»¤æå¼ ${pinnedBrowserId}ï¼æå¹³å°éæ©ï¼ï¼ç¨ç­åéè¯è¯·æ±ï¼` +

      `(2) è¥ä»å¤±è´¥ï¼åç¥ç¨æ·å¨å°åæ è®¿é® ${pinnedBrowserId}://inspect/#remote-debugging éæ°å¾éåè®¸ã` +

      `è¥æ³æ¢æå¶ä»æµè§å¨ï¼è¯·åå¨ç»ç«¯è¿è¡ pkill -f cdp-proxy.mjs éç½®ã`

    );

  }

  // ä»å¨ãä»æªæåè¿æ¥ + æ åå¥½/overrideãæ¶åè®¸åºå®ç«¯å£ååºï¼æå¨ --remote-debugging-port å¯å¨åºæ¯ï¼

  const fallbackPort = await findFallbackPort();

  if (fallbackPort !== null) {

    connectedBrowser = { id: 'unknown', label: 'æªç¥ï¼éè¿æå¨è°è¯ç«¯å£è¿æ¥ï¼', source: 'fallback' };

    console.log(`[CDP Proxy] éè¿æå¨è°è¯ç«¯å£è¿æ¥: ${fallbackPort}`);

    return { port: fallbackPort, wsPath: null };

  }

  return null;

}



async function resolveBrowserWsUrl(port) {

  try {

    const res = await fetch(`http://127.0.0.1:${port}/json/version`);

    const json = await res.json();

    if (json.webSocketDebuggerUrl) {

      // Rewrite host to 127.0.0.1 (Chrome sometimes uses localhost)

      const u = new URL(json.webSocketDebuggerUrl);

      return `ws://127.0.0.1:${port}${u.pathname}`;

    }

  } catch {}

  return null;

}



async function getWebSocketUrl(port, wsPath) {

  if (wsPath) return `ws://127.0.0.1:${port}${wsPath}`;

  // Fallback: resolve the actual browser WS URL from Chrome's HTTP endpoint

  const url = await resolveBrowserWsUrl(port);

  if (url) return url;

  return `ws://127.0.0.1:${port}/devtools/browser`;

}



// --- WebSocket è¿æ¥ç®¡ç ---

let chromePort = null;

let chromeWsPath = null;



let connectingPromise = null;

async function connect() {

  if (ws && (ws.readyState === WS.OPEN || ws.readyState === 1)) return;

  if (connectingPromise) return connectingPromise;  // å¤ç¨è¿è¡ä¸­çè¿æ¥



  if (!chromePort) {

    const discovered = await discoverChromePort();

    if (!discovered) {

      throw new Error(

        'Chrome æªå¼å¯è¿ç¨è°è¯ç«¯å£ãè¯·ç¨ä»¥ä¸æ¹å¼å¯å¨ Chromeï¼\n' +

        '  macOS: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222\n' +

        '  Linux: google-chrome --remote-debugging-port=9222\n' +

        '  æå¨ chrome://flags ä¸­æç´¢ "remote debugging" å¹¶å¯ç¨'

      );

    }

    chromePort = discovered.port;

    chromeWsPath = discovered.wsPath;

  }



  const wsUrl = await getWebSocketUrl(chromePort, chromeWsPath);

  if (!wsUrl) throw new Error('æ æ³è·å Chrome WebSocket URL');



  return connectingPromise = new Promise((resolve, reject) => {

    ws = new WS(wsUrl);



    const onOpen = () => {

      cleanup();

      connectingPromise = null;

      console.log(`[CDP Proxy] å·²è¿æ¥æµè§å¨ (ç«¯å£ ${chromePort})`);

      resolve();

    };

    const onError = (e) => {

      cleanup();

      connectingPromise = null;

      ws = null;

      chromePort = null;

      chromeWsPath = null;

      const msg = e.message || e.error?.message || 'è¿æ¥å¤±è´¥';

      console.error('[CDP Proxy] è¿æ¥éè¯¯:', msg, 'ï¼ç«¯å£ç¼å­å·²æ¸é¤ï¼ä¸æ¬¡å°éæ°åç°ï¼');

      reject(new Error(msg));

    };

    const onClose = () => {

      console.log('[CDP Proxy] è¿æ¥æ­å¼');

      ws = null;

      chromePort = null; // éç½®ç«¯å£ç¼å­ï¼ä¸æ¬¡è¿æ¥éæ°åç°

      chromeWsPath = null;

      sessions.clear();

      managedTabs.clear();

    };

    const onMessage = (evt) => {

      const data = typeof evt === 'string' ? evt : (evt.data || evt);

      const msg = JSON.parse(typeof data === 'string' ? data : data.toString());



      if (msg.method === 'Target.attachedToTarget') {

        const { sessionId, targetInfo } = msg.params;

        sessions.set(targetInfo.targetId, sessionId);

      }

      // æ¦æªé¡µé¢å¯¹ Chrome è°è¯ç«¯å£çæ¢æµè¯·æ±ï¼åé£æ§ï¼

      if (msg.method === 'Fetch.requestPaused') {

        const { requestId, sessionId: sid } = msg.params;

        sendCDP('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }, sid).catch(() => {});

      }

      if (msg.id && pending.has(msg.id)) {

        const { resolve, timer } = pending.get(msg.id);

        clearTimeout(timer);

        pending.delete(msg.id);

        resolve(msg);

      }

    };



    function cleanup() {

      ws.removeEventListener?.('open', onOpen);

      ws.removeEventListener?.('error', onError);

    }



    // å¼å®¹ Node åç WebSocket å ws æ¨¡åçäºä»¶ API

    if (ws.on) {

      ws.on('open', onOpen);

      ws.on('error', onError);

      ws.on('close', onClose);

      ws.on('message', onMessage);

    } else {

      ws.addEventListener('open', onOpen);

      ws.addEventListener('error', onError);

      ws.addEventListener('close', onClose);

      ws.addEventListener('message', onMessage);

    }

  });

}



function sendCDP(method, params = {}, sessionId = null) {

  return new Promise((resolve, reject) => {

    if (!ws || (ws.readyState !== WS.OPEN && ws.readyState !== 1)) {

      return reject(new Error('WebSocket æªè¿æ¥'));

    }

    const id = ++cmdId;

    const msg = { id, method, params };

    if (sessionId) msg.sessionId = sessionId;

    const timer = setTimeout(() => {

      pending.delete(id);

      reject(new Error('CDP å½ä»¤è¶æ¶: ' + method));

    }, 30000);

    pending.set(id, { resolve, timer });

    ws.send(JSON.stringify(msg));

  });

}



// å·²å¯ç¨ç«¯å£æ¦æªç session éåï¼é¿åéå¤å¯ç¨ï¼

const portGuardedSessions = new Set();



async function ensureSession(targetId) {

  if (sessions.has(targetId)) return sessions.get(targetId);

  const resp = await sendCDP('Target.attachToTarget', { targetId, flatten: true });

  if (resp.result?.sessionId) {

    const sid = resp.result.sessionId;

    sessions.set(targetId, sid);

    // å¯ç¨è°è¯ç«¯å£æ¢æµæ¦æª

    await enablePortGuard(sid);

    return sid;

  }

  throw new Error('attach å¤±è´¥: ' + JSON.stringify(resp.error));

}



// æ¦æªé¡µé¢å¯¹ Chrome è°è¯ç«¯å£çæ¢æµï¼åé£æ§ï¼

// åªæ¦æª 127.0.0.1:{chromePort} çè¯·æ±ï¼ä¸å½±åå¶ä»ä»»ä½æ¬å°æå¡

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

  } catch { /* Fetch åå¯ç¨å¤±è´¥ä¸å½±åä¸»æµç¨ */ }

}



// --- é²ç½® Tab èªå¨æ¸ç ---

function touchTab(targetId) {

  const entry = managedTabs.get(targetId);

  if (entry) entry.lastAccessed = Date.now();

}



async function cleanupIdleTabs() {

  if (!ws || (ws.readyState !== WS.OPEN && ws.readyState !== 1)) return;

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

  if (!ws || (ws.readyState !== WS.OPEN && ws.readyState !== 1)) return;

  const targets = [...managedTabs.keys()];

  for (const targetId of targets) {

    try { await sendCDP('Target.closeTarget', { targetId }); } catch { /* ignore */ }

    sessions.delete(targetId);

    managedTabs.delete(targetId);

  }

  if (targets.length) console.log(`[CDP Proxy] Shutdown: closed ${targets.length} managed tab(s)`);

}



// --- ç­å¾é¡µé¢å è½½ ---

async function waitForLoad(sessionId, timeoutMs = 15000) {

  // å¯ç¨ Page å

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

          expression: 'document.readyState',

          returnByValue: true,

        }, sessionId);

        if (resp.result?.result?.value === 'complete') {

          done('complete');

        }

      } catch { /* å¿½ç¥ */ }

    }, 500);

  });

}



// --- è¯»å POST body ---

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



  try {

    // /health ä¸éè¦è¿æ¥æµè§å¨

    if (pathname === '/health') {

      const connected = ws && (ws.readyState === WS.OPEN || ws.readyState === 1);

      res.end(JSON.stringify({

        status: 'ok',

        connected,

        browser: connectedBrowser,

        sessions: sessions.size,

        managedTabs: managedTabs.size,

        chromePort,

      }));

      return;

    }



    await connect();



    // GET /targets - ååºææé¡µé¢

    if (pathname === '/targets') {

      const resp = await sendCDP('Target.getTargets');

      const pages = resp.result.targetInfos.filter(t => t.type === 'page');

      res.end(JSON.stringify(pages, null, 2));

    }



    // POST /new (body=URL) - åå»ºæ°åå° tab

    else if (pathname === '/new') {

      if (req.method !== 'POST') {

        res.statusCode = 400;

        res.end(JSON.stringify({

          error: 'v2.5.3 èµ· /new æ¹ä¸º POST ä¼  URLï¼é¿åç®æ  URL å« query æ¶è¢«éè¯¯ååï¼',

          migration: 'references/migration-2.5.3.md',

          example: "curl -X POST --data-raw 'https://example.com' http://localhost:3456/new",

        }));

        return;

      }

      const body = (await readBody(req)).trim();

      const targetUrl = body || 'about:blank';

      const resp = await sendCDP('Target.createTarget', { url: targetUrl, background: true });

      const targetId = resp.result.targetId;

      managedTabs.set(targetId, { lastAccessed: Date.now() });



      // ç­å¾é¡µé¢å è½½

      if (targetUrl !== 'about:blank') {

        try {

          const sid = await ensureSession(targetId);

          await waitForLoad(sid);

        } catch { /* éè´å½ï¼ç»§ç»­ */ }

      }



      res.end(JSON.stringify({ targetId }));

    }



    // GET /close?target=xxx - å³é­ tab

    else if (pathname === '/close') {

      const resp = await sendCDP('Target.closeTarget', { targetId: q.target });

      sessions.delete(q.target);

      managedTabs.delete(q.target);

      res.end(JSON.stringify(resp.result));

    }



    // POST /navigate?target=xxx (body=URL) - å¯¼èªï¼èªå¨ç­å¾å è½½ï¼

    else if (pathname === '/navigate') {

      if (req.method !== 'POST') {

        res.statusCode = 400;

        res.end(JSON.stringify({

          error: 'v2.5.3 èµ· /navigate æ¹ä¸º POST ä¼  URLï¼é¿åç®æ  URL å« query æ¶è¢«éè¯¯ååï¼',

          migration: 'references/migration-2.5.3.md',

          example: "curl -X POST --data-raw 'https://example.com' 'http://localhost:3456/navigate?target=ID'",

        }));

        return;

      }

      const targetUrl = (await readBody(req)).trim();

      const sid = await ensureSession(q.target);

      const resp = await sendCDP('Page.navigate', { url: targetUrl }, sid);



      // ç­å¾é¡µé¢å è½½å®æ

      await waitForLoad(sid);



      res.end(JSON.stringify(resp.result));

    }



    // GET /back?target=xxx - åé

    else if (pathname === '/back') {

      const sid = await ensureSession(q.target);

      await sendCDP('Runtime.evaluate', { expression: 'history.back()' }, sid);

      await waitForLoad(sid);

      res.end(JSON.stringify({ ok: true }));

    }



    // POST /eval?target=xxx - æ§è¡ JS

    else if (pathname === '/eval') {

      const sid = await ensureSession(q.target);

      const body = await readBody(req);

      const expr = body || q.expr || 'document.title';

      const resp = await sendCDP('Runtime.evaluate', {

        expression: expr,

        returnByValue: true,

        awaitPromise: true,

      }, sid);

      if (resp.result?.result?.value !== undefined) {

        res.end(JSON.stringify({ value: resp.result.result.value }));

      } else if (resp.result?.exceptionDetails) {

        res.statusCode = 400;

        res.end(JSON.stringify({ error: resp.result.exceptionDetails.text }));

      } else {

        res.end(JSON.stringify(resp.result));

      }

    }



    // POST /click?target=xxx - ç¹å»ï¼body ä¸º CSS éæ©å¨ï¼

    // POST /click?target=xxx â JS å±é¢ç¹å»ï¼ç®åå¿«éï¼è¦çå¤§å¤æ°åºæ¯ï¼

    else if (pathname === '/click') {

      const sid = await ensureSession(q.target);

      const selector = await readBody(req);

      if (!selector) {

        res.statusCode = 400;

        res.end(JSON.stringify({ error: 'POST body éè¦ CSS éæ©å¨' }));

        return;

      }

      const selectorJson = JSON.stringify(selector);

      const js = `(() => {

        const el = document.querySelector(${selectorJson});

        if (!el) return { error: 'æªæ¾å°åç´ : ' + ${selectorJson} };

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



    // POST /clickAt?target=xxx â CDP æµè§å¨çº§çå®é¼ æ ç¹å»ï¼ç®ç¨æ·æå¿ï¼è½è§¦åæä»¶å¯¹è¯æ¡ãç»è¿åèªå¨åæ£æµï¼

    else if (pathname === '/clickAt') {

      const sid = await ensureSession(q.target);

      const selector = await readBody(req);

      if (!selector) {

        res.statusCode = 400;

        res.end(JSON.stringify({ error: 'POST body éè¦ CSS éæ©å¨' }));

        return;

      }

      const selectorJson = JSON.stringify(selector);

      const js = `(() => {

        const el = document.querySelector(${selectorJson});

        if (!el) return { error: 'æªæ¾å°åç´ : ' + ${selectorJson} };

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



    // POST /setFiles?target=xxx â ç» file input è®¾ç½®æ¬å°æä»¶ï¼ç»è¿æä»¶å¯¹è¯æ¡ï¼

    // body: JSON { "selector": "input[type=file]", "files": ["/path/to/file1.png", "/path/to/file2.png"] }

    else if (pathname === '/setFiles') {

      const sid = await ensureSession(q.target);

      const body = JSON.parse(await readBody(req));

      if (!body.selector || !body.files) {

        res.statusCode = 400;

        res.end(JSON.stringify({ error: 'éè¦ selector å files å­æ®µ' }));

        return;

      }

      // è·å DOM èç¹

      await sendCDP('DOM.enable', {}, sid);

      const doc = await sendCDP('DOM.getDocument', {}, sid);

      const node = await sendCDP('DOM.querySelector', {

        nodeId: doc.result.root.nodeId,

        selector: body.selector

      }, sid);

      if (!node.result?.nodeId) {

        res.statusCode = 400;

        res.end(JSON.stringify({ error: 'æªæ¾å°åç´ : ' + body.selector }));

        return;

      }

      // è®¾ç½®æä»¶

      await sendCDP('DOM.setFileInputFiles', {

        nodeId: node.result.nodeId,

        files: body.files

      }, sid);

      res.end(JSON.stringify({ success: true, files: body.files.length }));

    }



    // GET /scroll?target=xxx&y=3000 - æ»å¨

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

      // ç­å¾æå è½½è§¦å

      await new Promise(r => setTimeout(r, 800));

      res.end(JSON.stringify({ value: resp.result?.result?.value }));

    }



    // GET /screenshot?target=xxx&file=/tmp/x.png - æªå¾

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



    // GET /info?target=xxx - è·åé¡µé¢ä¿¡æ¯

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

        error: 'æªç¥ç«¯ç¹',

        endpoints: {

          '/health': 'GET - å¥åº·æ£æ¥',

          '/targets': 'GET - ååºææé¡µé¢ tab',

          '/new': 'POST body=URL - åå»ºæ°åå° tabï¼èªå¨ç­å¾å è½½ï¼',

          '/close?target=': 'GET - å³é­ tab',

          '/navigate?target=': 'POST body=URL - å¯¼èªï¼èªå¨ç­å¾å è½½ï¼',

          '/back?target=': 'GET - åé',

          '/info?target=': 'GET - é¡µé¢æ é¢/URL/ç¶æ',

          '/eval?target=': 'POST body=JSè¡¨è¾¾å¼ - æ§è¡ JS',

          '/click?target=': 'POST body=CSSéæ©å¨ - ç¹å»åç´ ',

          '/scroll?target=&y=&direction=': 'GET - æ»å¨é¡µé¢',

          '/screenshot?target=&file=': 'GET - æªå¾',

        },

      }));

    }

  } catch (e) {

    res.statusCode = 500;

    res.end(JSON.stringify({ error: e.message }));

  }

});



// æ£æ¥ç«¯å£æ¯å¦è¢«å ç¨

function checkPortAvailable(port) {

  return new Promise((resolve) => {

    const s = net.createServer();

    s.once('error', () => resolve(false));

    s.once('listening', () => { s.close(); resolve(true); });

    s.listen(port, '127.0.0.1');

  });

}



async function main() {

  // æ£æ¥æ¯å¦å·²æ proxy å¨è¿è¡

  const available = await checkPortAvailable(PORT);

  if (!available) {

    // éªè¯å·²æå®ä¾æ¯å¦å¥åº·

    try {

      const ok = await new Promise((resolve) => {

        http.get(`http://127.0.0.1:${PORT}/health`, { timeout: 2000 }, (res) => {

          let d = '';

          res.on('data', c => d += c);

          res.on('end', () => resolve(d.includes('"ok"')));

        }).on('error', () => resolve(false));

      });

      if (ok) {

        console.log(`[CDP Proxy] å·²æå®ä¾è¿è¡å¨ç«¯å£ ${PORT}ï¼éåº`);

        process.exit(0);

      }

    } catch { /* ç«¯å£å ç¨ä½é proxyï¼ç»§ç»­æ¥é */ }

    console.error(`[CDP Proxy] ç«¯å£ ${PORT} å·²è¢«å ç¨`);

    process.exit(1);

  }



  server.listen(PORT, '127.0.0.1', () => {

    console.log(`[CDP Proxy] è¿è¡å¨ http://localhost:${PORT}`);

    // å¯å¨æ¶å°è¯è¿æ¥ Chromeï¼éé»å¡ï¼

    connect().catch(e => console.error('[CDP Proxy] åå§è¿æ¥å¤±è´¥:', e.message, 'ï¼å°å¨é¦æ¬¡è¯·æ±æ¶éè¯ï¼'));

  });



  // å®æ¶æ¸çé²ç½® tab

  const cleanupTimer = setInterval(cleanupIdleTabs, CLEANUP_INTERVAL);

  cleanupTimer.unref();



  const shutdown = async (sig) => {

    console.log(`[CDP Proxy] ${sig}, cleaning up...`);

    clearInterval(cleanupTimer);

    await closeAllManagedTabs();

    process.exit(0);

  };

  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('SIGTERM', () => shutdown('SIGTERM'));

}



// é²æ­¢æªæè·å¼å¸¸å¯¼è´è¿ç¨å´©æº

process.on('uncaughtException', (e) => {

  console.error('[CDP Proxy] æªæè·å¼å¸¸:', e.message);

});

process.on('unhandledRejection', (e) => {

  console.error('[CDP Proxy] æªå¤çæç»:', e?.message || e);

});



main();

