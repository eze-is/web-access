#!/usr/bin/env node
// 集中维护共享 Proxy；身份与忙碌状态由服务端拥有，不扫描或强杀系统进程。
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameBrowser, readConfig } from './browser-discovery.mjs';
import { resolveProxyEndpoint } from './proxy-endpoint.mjs';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const STOP_TIMEOUT_MS = 15000;
const PROXY_CONFIG = readConfig();
let HEALTH_HOST = '127.0.0.1';

class MaintenanceError extends Error {
  constructor(message, details = {}, exitCode = 1) {
    super(message);
    this.details = details;
    this.exitCode = exitCode;
  }
}

// 每个维护请求独占一条连接（agent: false）：Node 19+ 默认 keep-alive，
// 若 /shutdown 用过的连接被放回池中，退出观察的 /health 会复用它，在 Proxy process.exit 时收到 ECONNRESET。
function requestJson(port, pathname, { method = 'GET', body, timeoutMs = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: HEALTH_HOST, port, path: pathname, method, agent: false,
      headers: payload === null ? {} : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;
        if (text.length > 1024 * 1024) req.destroy(new Error('维护响应过大'));
      });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ code: res.statusCode, body: JSON.parse(text) }); }
        catch { reject(new MaintenanceError('Proxy 返回了无效 JSON；保留当前服务')); }
      });
    });
    // 使用总时限，持续发送零碎响应也不能拖住维护流程。
    const timer = setTimeout(() => req.destroy(new Error('Proxy 维护请求超时')), timeoutMs);
    req.once('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(payload);
  });
}

async function readHealth(port, timeoutMs = 1000) {
  let result;
  try { result = await requestJson(port, '/health', { timeoutMs }); }
  catch (error) {
    if (error.code === 'ECONNREFUSED') return null;
    throw error;
  }
  if (result.code !== 200 || result.body?.status !== 'ok') {
    throw new MaintenanceError('端口上的服务未满足 Proxy 健康契约；保留当前服务', { response: result.body });
  }
  return result.body;
}

// 连接被正在退出的进程中断：读到重置（ECONNRESET，含 socket hang up）或写入时对端已关（EPIPE）。
// 两者都只说明实例可能正在退出，不能据此判定已退出或未退出。
function isBrokenConnection(error) {
  return error.code === 'ECONNRESET' || error.code === 'EPIPE';
}

// 另一维护者正在停止实例时，连接可能在其退出瞬间被中断（含 connect ECONNRESET）。
// 短暂重试到得到明确结果：健康响应、拒绝连接（null）或其他错误；重置本身不作为结论。
async function readHealthSettled(port) {
  for (let attempt = 0; ; attempt++) {
    try { return await readHealth(port); }
    catch (error) {
      if (!isBrokenConnection(error) || attempt >= 20) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

function requireIdentity(health) {
  if (typeof health.instanceId !== 'string' || !health.instanceId) {
    throw new MaintenanceError('旧服务没有 instanceId，无法安全维护；需要一次性迁移，禁止自动强停', { health }, 2);
  }
}

function isBusy(health) {
  return ['activeRequests', 'managedTabs', 'pendingCommands'].some(key => health[key] > 0)
    || ['discovering', 'connecting'].includes(health.connectionState);
}

// 只有 ECONNREFUSED 证明旧实例已离开端口。退出过程中监听 socket 仍可能接入新连接再随进程重置，
// 此时的 ECONNRESET（含 socket hang up）说明实例正在退出，继续观察而不是报错，也不据此判定已退出。
async function waitForDeparture(port, instanceId) {
  const started = Date.now();
  const deadline = started + STOP_TIMEOUT_MS;
  // 读到健康响应的次数同时有界，避免持续快速响应导致无界轮询；连接被重置只受总时限约束，不占这个次数。
  let observations = 0;
  while (observations < 30 && Date.now() < deadline) {
    let health;
    try { health = await readHealth(port, Math.max(1, Math.min(1000, deadline - Date.now()))); }
    catch (error) {
      if (!isBrokenConnection(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
      continue;
    }
    if (!health) return null;
    requireIdentity(health);
    if (health.instanceId !== instanceId) return health;
    observations++;
    await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(1, deadline - Date.now()))));
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  throw new MaintenanceError(`目标 Proxy 在 ${seconds} 秒内未退出；没有强停或启动第二个实例`, { instanceId });
}

// /shutdown 的连接被重置后，区分「实例正在退出」与「停止请求根本没被接受」：
// Proxy 在回 202 之前同步进入 maintenance 且不再退出该状态，所以同一实例仍可读且 maintenance 不为 true，
// 就说明停止没有生效，应立即如实失败，而不是空等退出。读不到（拒绝、再次重置、已替换）交给退出观察处理。
async function stopNotAccepted(port, instanceId) {
  try {
    const current = await readHealth(port);
    return current?.instanceId === instanceId && current.maintenance !== true ? current : null;
  } catch { return null; }
}

async function requestStop(port, health) {
  requireIdentity(health);
  if (isBusy(health)) {
    throw new MaintenanceError('Proxy 正在连接、执行任务或仍拥有标签页，请等任务完成并清理后再维护', { status: 'busy', health }, 2);
  }
  let result;
  try {
    result = await requestJson(port, '/shutdown', {
      method: 'POST', body: { instanceId: health.instanceId },
    });
  } catch (error) {
    // 另一维护者可能刚好停止了同一实例（端口已释放为 ECONNREFUSED，退出途中为 ECONNRESET / EPIPE），
    // 后续仍只观察旧身份；观察有界，不强停也不据此启动。
    if (error.code !== 'ECONNREFUSED' && !isBrokenConnection(error)) throw error;
    const current = isBrokenConnection(error) && await stopNotAccepted(port, health.instanceId);
    if (current) {
      throw new MaintenanceError('停止请求的连接被重置，服务仍在运行且没有进入维护，停止未生效；当前服务已保留，可稍后重试', { health: current });
    }
    return waitForDeparture(port, health.instanceId);
  }
  if (result.code === 409) {
    const current = await readHealthSettled(port);
    if (!current) return null;
    requireIdentity(current);
    if (current.instanceId !== health.instanceId) return current;
    throw new MaintenanceError('Proxy 拒绝维护，当前服务已保留', {
      status: isBusy(current) ? 'busy' : 'conflict', health: current, response: result.body,
    }, 2);
  }
  if (result.code !== 202 || result.body?.instanceId !== health.instanceId) {
    throw new MaintenanceError('Proxy 未确认停止目标实例；当前服务已保留', { response: result.body });
  }
  return waitForDeparture(port, health.instanceId);
}

function runCheckDeps(port, browserId) {
  console.log('proxy: 维护启动一次；浏览器可能需要一次授权，请按 check-deps 提示等待');
  return new Promise((resolve, reject) => {
    const args = [path.join(SCRIPTS, 'check-deps.mjs')];
    if (browserId && browserId !== 'unknown') args.push('--browser', browserId);
    const child = spawn(process.execPath, args, {
      env: { ...process.env, CDP_PROXY_PORT: String(port) },
      stdio: 'inherit', windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function restartedResult(health, previous, reused, startup) {
  if (!health) throw new MaintenanceError('维护启动后未读到健康服务', { startup });
  requireIdentity(health);
  if (health.instanceId === previous?.instanceId) {
    throw new MaintenanceError('维护后仍是旧实例，没有确认升级完成', { health, startup });
  }
  const expectedBrowserId = previous?.browser?.id;
  // 浏览器身份按数据目录比较：升级前实例报告的旧值 chrome 与新实例报告的标准路径是同一浏览器。
  if (typeof expectedBrowserId === 'string' && expectedBrowserId && expectedBrowserId !== 'unknown'
    && !sameBrowser(health.browser?.id, expectedBrowserId)) {
    throw new MaintenanceError('新实例的浏览器不符合维护前的选择；新实例已保留', {
      status: 'conflict', expectedBrowserId, health, ...(startup ? { startup } : {}),
    }, 2);
  }
  if (health.maintenance) {
    throw new MaintenanceError('新实例正在被维护，暂不能确认可用', { health, startup });
  }
  if (health.connected !== true) {
    return { status: 'waitingAuthorization', reused, health, ...(startup ? { startup } : {}) };
  }
  if (startup && startup.code !== 0) {
    throw new MaintenanceError('健康服务已运行，但启动检查未通过，请查看上述提示', { health, startup });
  }
  return { status: 'ready', reused, health };
}

async function main() {
  const [action = 'status', ...extra] = process.argv.slice(2);
  if (action === '--help' && !extra.length) {
    console.log('用法：node proxy-maintenance.mjs [status|restart|stop]；默认 http://127.0.0.1:3456');
    return;
  }
  if (!['status', 'restart', 'stop'].includes(action) || extra.length) {
    throw new MaintenanceError('用法：node proxy-maintenance.mjs [status|restart|stop]', {}, 2);
  }
  const remoteBase = String(process.env.CDP_PROXY_BASE_URL || PROXY_CONFIG.CDP_PROXY_BASE_URL || '').trim();
  if (remoteBase) {
    throw new MaintenanceError(`检测到远端 Proxy（${remoteBase}）；维护命令只能在有浏览器的主机执行`, {}, 2);
  }
  let endpoint;
  try { endpoint = resolveProxyEndpoint(PROXY_CONFIG); }
  catch (error) { throw new MaintenanceError(`监听配置无效：${error.message}`, {}, 2); }
  HEALTH_HOST = endpoint.localHost;
  const port = endpoint.port;
  const health = await readHealthSettled(port);
  if (action === 'status') {
    console.log(JSON.stringify(health ? { status: 'running', health } : { status: 'stopped' }));
    return;
  }
  const replacement = health ? await requestStop(port, health) : null;
  if (action === 'stop') {
    console.log(JSON.stringify(replacement
      ? { status: 'replaced', stoppedInstanceId: health.instanceId, health: replacement }
      : { status: 'stopped', ...(health ? { stoppedInstanceId: health.instanceId } : {}) }));
    return;
  }
  let result;
  if (replacement) {
    result = restartedResult(replacement, health, true);
  } else {
    const startup = await runCheckDeps(port, health?.browser?.id);
    result = restartedResult(await readHealthSettled(port), health, false, startup);
  }
  console.log(JSON.stringify(result));
  if (result.status === 'waitingAuthorization') process.exitCode = 3;
}

try { await main(); }
catch (error) {
  console.error(JSON.stringify({ status: 'error', message: error.message, ...error.details }));
  process.exitCode = error.exitCode || 1;
}
