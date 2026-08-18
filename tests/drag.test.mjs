import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitForProxy(child, logs) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`CDP Proxy exited early (${child.exitCode}):\n${logs.join('')}`);
    }
    const portMatch = logs.join('').match(/\[CDP Proxy\] 运行在 http:\/\/localhost:(\d+)/);
    if (portMatch) {
      const baseUrl = `http://127.0.0.1:${portMatch[1]}`;
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) return baseUrl;
      } catch {
        // The proxy may still be starting.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`CDP Proxy did not become ready:\n${logs.join('')}`);
}

async function post(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('POST /drag moves a page element through real mouse events', async () => {
  const fixtureServer = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html>
      <style>
        #track { position: relative; width: 400px; height: 40px; margin: 100px; background: #ddd; }
        #track-two { position: relative; width: 400px; height: 40px; margin: 100px; background: #ddd; }
        #handle { position: absolute; left: 0; width: 40px; height: 40px; background: #1677ff; }
        #handle-two { position: absolute; left: 0; width: 40px; height: 40px; background: #722ed1; }
        #target { position: absolute; left: 300px; width: 40px; height: 40px; box-sizing: border-box; border: 3px solid #52c41a; }
        #zero-size { position: absolute; width: 0; height: 0; }
      </style>
      <div id="track"><div id="target"></div><div id="handle"></div><div id="zero-size"></div></div>
      <div id="track-two"><div id="handle-two"></div></div>
      <output id="status">idle</output>
      <button id="click-target">click target</button>
      <script>
        window.clickCount = 0;
        window.dragFixture = {
          ready: false, error: null, downs: 0, moves: 0, ups: 0,
          validButtonMoves: 0, invalidButtons: 0, inputOrder: []
        };
        try {
          const handleElement = document.querySelector('#handle');
          const statusOutput = document.querySelector('#status');
          let dragging = false;
          let pointerStart = 0;
          let handleStart = 0;
          handleElement.addEventListener('mousedown', (event) => {
            window.dragFixture.downs++;
            dragging = true;
            pointerStart = event.clientX;
            handleStart = Number.parseFloat(handleElement.style.left) || 0;
          });
          document.addEventListener('mousemove', (event) => {
            window.dragFixture.moves++;
            if (!dragging) return;
            if (event.buttons !== 1) {
              window.dragFixture.invalidButtons++;
              return;
            }
            window.dragFixture.validButtonMoves++;
            const next = Math.max(0, Math.min(360, handleStart + event.clientX - pointerStart));
            handleElement.style.left = next + 'px';
          });
          document.addEventListener('mouseup', () => {
            window.dragFixture.ups++;
            if (!dragging) return;
            dragging = false;
            statusOutput.value = Number.parseFloat(handleElement.style.left) >= 200 ? 'dragged' : 'short';
          });
          document.addEventListener('mousedown', (event) => {
            if (event.target.matches('#handle, #handle-two')) {
              window.dragFixture.inputOrder.push('down:' + event.target.id);
            }
          });
          document.addEventListener('mouseup', () => window.dragFixture.inputOrder.push('up'));
          document.querySelector('#click-target').addEventListener('click', () => window.clickCount++);
          window.dragFixture.ready = true;
        } catch (error) {
          window.dragFixture.error = error.message;
        }
      </script>`);
  });

  const fixturePort = await listen(fixtureServer);

  const logs = [];
  const proxyArgs = ['scripts/cdp-proxy.mjs'];
  if (process.env.WEB_ACCESS_TEST_BROWSER) {
    proxyArgs.push('--browser', process.env.WEB_ACCESS_TEST_BROWSER);
  }
  const proxy = spawn(process.execPath, proxyArgs, {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      CDP_PROXY_PORT: '0',
      CDP_TAB_IDLE_TIMEOUT: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proxy.stdout.on('data', (chunk) => {
    logs.push(chunk.toString());
    if (process.env.WEB_ACCESS_TEST_DEBUG) process.stderr.write(chunk);
  });
  proxy.stderr.on('data', (chunk) => {
    logs.push(chunk.toString());
    if (process.env.WEB_ACCESS_TEST_DEBUG) process.stderr.write(chunk);
  });

  try {
    const baseUrl = await waitForProxy(proxy, logs);
    const created = await post(baseUrl, '/new', `http://127.0.0.1:${fixturePort}`);
    assert.equal(created.status, 200, JSON.stringify(created.body));

    const initial = await post(
      baseUrl,
      `/eval?target=${created.body.targetId}`,
      `({
        ready: document.readyState,
        fixtureReady: window.dragFixture?.ready,
        fixtureError: window.dragFixture?.error,
      })`,
    );
    assert.deepEqual(initial.body.value, { ready: 'complete', fixtureReady: true, fixtureError: null });

    const dragged = await post(baseUrl, `/drag?target=${created.body.targetId}`, {
      source: '#handle',
      deltaX: 240,
      deltaY: 0,
      steps: 12,
      durationMs: 120,
    });
    assert.equal(dragged.status, 200, JSON.stringify(dragged.body));
    assert.deepEqual(dragged.body.hit, { tag: 'DIV', id: 'handle' });

    const result = await post(
      baseUrl,
      `/eval?target=${created.body.targetId}`,
      `({
        status: document.querySelector('#status').value,
        left: document.querySelector('#handle').style.left,
        downs: window.dragFixture.downs,
        moves: window.dragFixture.moves,
        ups: window.dragFixture.ups,
        validButtonMoves: window.dragFixture.validButtonMoves,
        invalidButtons: window.dragFixture.invalidButtons,
      })`,
    );
    assert.equal(result.body.value.status, 'dragged');
    assert.equal(result.body.value.left, '240px');
    assert.equal(result.body.value.downs, 1);
    assert.ok(result.body.value.moves >= 13, JSON.stringify(result.body.value));
    assert.equal(result.body.value.ups, 1);
    assert.ok(result.body.value.validButtonMoves >= 12, JSON.stringify(result.body.value));

    const clicked = await post(baseUrl, `/clickAt?target=${created.body.targetId}`, '#click-target');
    assert.equal(clicked.status, 200, JSON.stringify(clicked.body));
    const clickCount = await post(
      baseUrl,
      `/eval?target=${created.body.targetId}`,
      'window.clickCount',
    );
    assert.equal(clickCount.body.value, 1);

    await post(
      baseUrl,
      `/eval?target=${created.body.targetId}`,
      `(() => {
        document.querySelector('#handle').style.left = '0px';
        document.querySelector('#status').value = 'idle';
        Object.assign(window.dragFixture, {
          downs: 0, moves: 0, ups: 0, validButtonMoves: 0, invalidButtons: 0
        });
        return true;
      })()`,
    );
    const draggedToTarget = await post(baseUrl, `/drag?target=${created.body.targetId}`, {
      source: '#handle',
      target: '#target',
      steps: 10,
      durationMs: 100,
    });
    assert.equal(draggedToTarget.status, 200, JSON.stringify(draggedToTarget.body));

    const targetResult = await post(
      baseUrl,
      `/eval?target=${created.body.targetId}`,
      `({
        status: document.querySelector('#status').value,
        left: document.querySelector('#handle').style.left,
        downs: window.dragFixture.downs,
        moves: window.dragFixture.moves,
        ups: window.dragFixture.ups,
        validButtonMoves: window.dragFixture.validButtonMoves,
        invalidButtons: window.dragFixture.invalidButtons,
      })`,
    );
    assert.equal(targetResult.body.value.status, 'dragged');
    assert.equal(targetResult.body.value.left, '300px');
    assert.equal(targetResult.body.value.downs, 1);
    assert.ok(targetResult.body.value.moves >= 11, JSON.stringify(targetResult.body.value));
    assert.equal(targetResult.body.value.ups, 1);
    assert.ok(targetResult.body.value.validButtonMoves >= 10, JSON.stringify(targetResult.body.value));

    await post(
      baseUrl,
      `/eval?target=${created.body.targetId}`,
      `(() => {
        document.querySelector('#handle').style.left = '0px';
        window.dragFixture.inputOrder = [];
        return true;
      })()`,
    );
    const concurrentDrags = await Promise.all([
      post(baseUrl, `/drag?target=${created.body.targetId}`, {
        source: '#handle', deltaX: 100, steps: 20, durationMs: 200,
      }),
      post(baseUrl, `/drag?target=${created.body.targetId}`, {
        source: '#handle-two', deltaX: 100, steps: 20, durationMs: 200,
      }),
    ]);
    assert.ok(concurrentDrags.every(({ status }) => status === 200), JSON.stringify(concurrentDrags));
    const inputOrder = await post(
      baseUrl,
      `/eval?target=${created.body.targetId}`,
      'window.dragFixture.inputOrder',
    );
    assert.equal(inputOrder.body.value.length, 4, JSON.stringify(inputOrder.body.value));
    assert.match(inputOrder.body.value[0], /^down:/);
    assert.equal(inputOrder.body.value[1], 'up');
    assert.match(inputOrder.body.value[2], /^down:/);
    assert.equal(inputOrder.body.value[3], 'up');

    const invalidRequests = [
      ['{', /合法 JSON/],
      [null, /JSON 对象/],
      [[], /JSON 对象/],
      [{ deltaX: 10 }, /source/],
      [{ source: '#handle' }, /target.*deltaX\/deltaY/],
      [{ source: '#handle', target: 123, deltaX: 20 }, /target.*字符串/],
      [{ source: '#handle', target: '#target', deltaX: '20' }, /deltaX.*数字/],
      [{ source: '#handle', target: '#target', deltaX: 10 }, /不能同时使用/],
      [{ source: '#missing', deltaX: 10 }, /未找到元素/],
      [{ source: '#handle', target: '#missing' }, /未找到元素/],
    ];
    for (const [body, expectedError] of invalidRequests) {
      const invalid = await post(baseUrl, `/drag?target=${created.body.targetId}`, body);
      assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
      assert.match(invalid.body.error, expectedError);
    }

    const zeroSize = await post(baseUrl, `/drag?target=${created.body.targetId}`, {
      source: '#zero-size',
      deltaX: 10,
    });
    assert.equal(zeroSize.status, 400, JSON.stringify(zeroSize.body));
    assert.match(zeroSize.body.error, /尺寸/);

    await post(
      baseUrl,
      `/eval?target=${created.body.targetId}`,
      `(() => {
        document.querySelector('#handle').style.left = '0px';
        const overlay = document.createElement('div');
        overlay.id = 'overlay';
        Object.assign(overlay.style, {
          position: 'absolute', left: '0', top: '0', width: '40px', height: '40px', zIndex: '10'
        });
        document.querySelector('#track').append(overlay);
        return true;
      })()`,
    );
    const coveredSource = await post(baseUrl, `/drag?target=${created.body.targetId}`, {
      source: '#handle',
      deltaX: 10,
    });
    assert.equal(coveredSource.status, 400, JSON.stringify(coveredSource.body));
    assert.match(coveredSource.body.error, /遮挡/);

    const missingTab = await post(baseUrl, '/drag', { source: '#handle', deltaX: 10 });
    assert.equal(missingTab.status, 400, JSON.stringify(missingTab.body));
    assert.match(missingTab.body.error, /target tab ID/);

    const unknownTab = await post(baseUrl, '/drag?target=does-not-exist', {
      source: '#handle', deltaX: 10,
    });
    assert.equal(unknownTab.status, 404, JSON.stringify(unknownTab.body));
    assert.match(unknownTab.body.error, /tab/);
  } finally {
    proxy.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise((resolve) => proxy.once('exit', resolve)),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    if (exited === false && proxy.exitCode === null) {
      proxy.kill('SIGKILL');
      await new Promise((resolve) => proxy.once('exit', resolve));
    }
    await close(fixtureServer);
  }
});
