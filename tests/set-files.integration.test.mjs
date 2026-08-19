import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSetFilesAcrossFrames } from '../scripts/set-files.mjs';

const CHROME_BIN = process.env.CHROME_BIN;

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

async function waitForFile(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = fs.readFileSync(file, 'utf8').trim();
      if (content) return content;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for browser state');
}

function createCDPClient(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let commandId = 0;

  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    entry.resolve(message);
  });

  return {
    opened,
    close: () => ws.close(),
    send(method, params = {}, sessionId = null) {
      return new Promise((resolve, reject) => {
        const id = ++commandId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP command timed out: ${method}`));
        }, 10_000);
        pending.set(id, {
          resolve: message => {
            clearTimeout(timer);
            resolve(message);
          },
        });
        const message = { id, method, params };
        if (sessionId) message.sessionId = sessionId;
        ws.send(JSON.stringify(message));
      });
    },
  };
}

test('uploads through one CDP WebSocket to a real cross-site OOPIF', {
  skip: !CHROME_BIN && 'Set CHROME_BIN to run the Chrome integration test',
  timeout: 30_000,
}, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-access-oopif-'));
  const uploadFile = path.join(tempDir, 'fixture.txt');
  fs.writeFileSync(uploadFile, 'fixture');

  const frameServer = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><input id="upload" type="file">');
  });
  const framePort = await listen(frameServer, 'localhost');
  const pageServer = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><iframe src="http://localhost:${framePort}/frame"></iframe>`);
  });
  const pagePort = await listen(pageServer, '127.0.0.1');

  const chrome = spawn(CHROME_BIN, [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--site-per-process',
    '--remote-debugging-port=0',
    `--user-data-dir=${tempDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  try {
    const activePort = await waitForFile(path.join(tempDir, 'DevToolsActivePort'));
    const [port, wsPath] = activePort.split(/\r?\n/);
    cdp = createCDPClient(`ws://127.0.0.1:${port}${wsPath}`);
    await cdp.opened;

    const sessions = new Map();
    async function ensureSession(targetId) {
      if (sessions.has(targetId)) return sessions.get(targetId);
      const response = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      if (response.error) throw new Error(response.error.message);
      sessions.set(targetId, response.result.sessionId);
      return response.result.sessionId;
    }

    const targetResponse = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${pagePort}/page`,
    });
    const pageTargetId = targetResponse.result.targetId;
    await waitFor(async () => {
      const response = await cdp.send('Target.getTargets');
      return response.result?.targetInfos?.some(info =>
        info.type === 'iframe' && info.url.includes(`localhost:${framePort}`));
    });

    const setFiles = createSetFilesAcrossFrames({
      sendCDP: cdp.send.bind(cdp),
      ensureSession,
    });
    const result = await setFiles(pageTargetId, {
      selector: '#upload',
      files: [uploadFile],
      frameUrl: `localhost:${framePort}`,
    });

    assert.equal(result.context, 'iframe');
    assert.equal(result.frameUrl.includes(`localhost:${framePort}`), true);
    const iframeSessionId = await ensureSession(result.targetId);
    const verify = await cdp.send('Runtime.evaluate', {
      expression: 'document.querySelector("#upload").files[0]?.name',
      returnByValue: true,
    }, iframeSessionId);
    assert.equal(verify.result.result.value, 'fixture.txt');

    const targetsAfterUpload = await cdp.send('Target.getTargets');
    assert.equal(
      targetsAfterUpload.result.targetInfos.some(info => info.targetId === pageTargetId),
      true,
    );
    await cdp.send('Target.closeTarget', { targetId: pageTargetId });
  } finally {
    cdp?.close();
    await Promise.all([closeServer(pageServer), closeServer(frameServer)]);
    const chromeExited = new Promise(resolve => chrome.once('exit', resolve));
    if (chrome.exitCode == null) chrome.kill('SIGTERM');
    await Promise.race([
      chromeExited,
      new Promise(resolve => setTimeout(resolve, 3_000)),
    ]);
    if (chrome.exitCode == null) {
      chrome.kill('SIGKILL');
      await chromeExited;
    }
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
