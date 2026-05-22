const PROXY_HTTP = 'http://127.0.0.1:3457';
const PROXY_WS = 'ws://127.0.0.1:3457/ext';
const RECONNECT_ALARM = 'web-access-reconnect';
const attachedTabs = new Set();

let ws = null;
let connectInFlight = false;
let lastConnectedAt = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
  connect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'status') {
    sendResponse({
      connected: ws?.readyState === WebSocket.OPEN,
      lastConnectedAt,
    });
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

connect();

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (connectInFlight) return;
  connectInFlight = true;

  try {
    const response = await fetch(`${PROXY_HTTP}/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return;
  } catch {
    return;
  } finally {
    connectInFlight = false;
  }

  try {
    ws = new WebSocket(PROXY_WS);
  } catch {
    return;
  }

  ws.onopen = () => {
    lastConnectedAt = new Date().toISOString();
    safeSend({
      type: 'hello',
      version: chrome.runtime.getManifest().version,
      browser: detectBrowser(),
      userAgent: navigator.userAgent,
    });
  };

  ws.onmessage = async (event) => {
    let command;
    try {
      command = JSON.parse(event.data);
    } catch {
      return;
    }

    const id = command?.id;
    if (typeof id !== 'string') return;
    try {
      const result = await handleCommand(command);
      safeSend({ id, ok: true, ...result });
    } catch (error) {
      safeSend({
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  ws.onclose = () => {
    ws = null;
  };

  ws.onerror = () => {
    try { ws?.close(); } catch {}
  };
}

function safeSend(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

async function handleCommand(command) {
  switch (command.action) {
    case 'targets':
      return { data: await listTargets() };
    case 'new':
      return await createTab(command.url || 'about:blank');
    case 'navigate':
      return await navigate(command.target, command.url);
    case 'back':
      return await back(command.target);
    case 'close':
      return await closeTab(command.target);
    case 'info':
      return await info(command.target);
    case 'eval':
      return { value: await evaluate(command.target, command.code || 'undefined') };
    case 'click':
      return { value: await click(command.target, command.selector || '') };
    case 'clickAt':
      return { value: await clickAt(command.target, command.selector || '') };
    case 'setFiles':
      return await setFiles(command.target, command.selector, command.files);
    case 'scroll':
      return { value: await scroll(command.target, command) };
    case 'screenshot':
      return { data: await screenshot(command.target) };
    default:
      throw new Error(`Unknown action: ${command.action}`);
  }
}

async function listTargets() {
  const targets = await chrome.debugger.getTargets();
  return targets
    .filter((target) => target.type === 'page' && target.tabId !== undefined)
    .map((target) => ({
      id: target.id,
      targetId: target.id,
      tabId: target.tabId,
      type: target.type,
      title: target.title,
      url: target.url,
      attached: target.attached,
    }));
}

async function createTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab.id) throw new Error('Chrome did not return a tab id');
  await waitForTabLoad(tab.id);
  return {
    targetId: await targetIdForTab(tab.id),
  };
}

async function navigate(target, url) {
  const tabId = await tabIdForTarget(target);
  const tab = await chrome.tabs.update(tabId, { url });
  await waitForTabLoad(tabId);
  return {
    title: tab.title,
    url: (await chrome.tabs.get(tabId)).url,
  };
}

async function back(target) {
  const tabId = await tabIdForTarget(target);
  if (typeof chrome.tabs.goBack === 'function') {
    await chrome.tabs.goBack(tabId);
  } else {
    await evaluate(target, 'history.back(); undefined');
  }
  await waitForTabLoad(tabId).catch(() => {});
  return { ok: true };
}

async function closeTab(target) {
  const tabId = await tabIdForTarget(target);
  await detach(tabId).catch(() => {});
  await chrome.tabs.remove(tabId);
  return { closed: target };
}

async function info(target) {
  const tabId = await tabIdForTarget(target);
  const tab = await chrome.tabs.get(tabId);
  return {
    targetId: target,
    tabId,
    title: tab.title,
    url: tab.url,
    status: tab.status,
  };
}

async function evaluate(target, expression) {
  const tabId = await tabIdForTarget(target);
  await ensureAttached(tabId);
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      'Runtime.evaluate failed',
    );
  }
  return result.result?.value;
}

async function click(target, selector) {
  return await evaluate(target, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('selector not found: ' + ${JSON.stringify(selector)});
    el.click();
    return true;
  })()`);
}

async function clickAt(target, selector) {
  const tabId = await tabIdForTarget(target);
  await ensureAttached(tabId);
  const rectResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('selector not found: ' + ${JSON.stringify(selector)});
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (rectResult.exceptionDetails) throw new Error(rectResult.exceptionDetails.text || 'clickAt failed');
  const point = rectResult.result?.value;
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
  });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  return true;
}

async function setFiles(target, selector = 'input[type=file]', files = []) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('files must be a non-empty array');
  const tabId = await tabIdForTarget(target);
  await ensureAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'DOM.enable');
  const doc = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument');
  const match = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector,
  });
  if (!match.nodeId) throw new Error(`selector not found: ${selector}`);
  await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
    nodeId: match.nodeId,
    files,
  });
  return { count: files.length };
}

async function scroll(target, { y, direction }) {
  const amount = Number.isFinite(y) ? y : direction === 'bottom' ? 'document.documentElement.scrollHeight' : 1000;
  const expression = direction === 'bottom'
    ? 'window.scrollTo(0, document.documentElement.scrollHeight); window.scrollY'
    : `window.scrollBy(0, ${Number(amount)}); window.scrollY`;
  return await evaluate(target, expression);
}

async function screenshot(target) {
  const tabId = await tabIdForTarget(target);
  await ensureAttached(tabId);
  const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
    format: 'png',
  });
  return result.data;
}

async function ensureAttached(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isDebuggableUrl(tab.url)) throw new Error(`Cannot debug URL: ${tab.url}`);
  if (attachedTabs.has(tabId)) {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: '1',
        returnByValue: true,
      });
      return;
    } catch {
      attachedTabs.delete(tabId);
    }
  }
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Another debugger is already attached')) throw error;
  }
  attachedTabs.add(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable').catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {});
}

async function detach(tabId) {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  await chrome.debugger.detach({ tabId });
}

async function tabIdForTarget(targetId) {
  const targets = await chrome.debugger.getTargets();
  const match = targets.find((target) => target.id === targetId && target.tabId !== undefined);
  if (!match) throw new Error(`target not found: ${targetId}`);
  return match.tabId;
}

async function targetIdForTab(tabId) {
  const targets = await chrome.debugger.getTargets();
  const match = targets.find((target) => target.tabId === tabId && target.type === 'page');
  if (!match) throw new Error(`target id not found for tab: ${tabId}`);
  return match.id;
}

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') finish();
    }).catch(finish);
  });
}

function isDebuggableUrl(url) {
  return !url ||
    url === 'about:blank' ||
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('data:');
}

function detectBrowser() {
  const ua = navigator.userAgent;
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('Chrome/')) return 'Chrome';
  return 'Chromium';
}
