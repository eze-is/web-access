import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { URL } from 'node:url';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const EXTENSION_ORIGIN_RE = /^(chrome|moz)-extension:\/\/[a-zA-Z0-9_-]+$/;

export class ExtensionBridge {
  constructor({ commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
    this.commandTimeoutMs = commandTimeoutMs;
    this.nextId = 0;
    this.pending = new Map();
    this.socket = null;
    this.extension = null;
  }

  isConnected() {
    return this.socket !== null;
  }

  attach(socket) {
    this.detach();
    this.socket = socket;
  }

  detach(socket = this.socket) {
    if (socket && this.socket === socket) {
      this.socket = null;
      this.extension = null;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Extension disconnected before response: ${id}`));
      }
      this.pending.clear();
    }
  }

  receive(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message?.type === 'hello') {
      this.extension = {
        version: typeof message.version === 'string' ? message.version : 'unknown',
        browser: typeof message.browser === 'string' ? message.browser : 'unknown',
        userAgent: typeof message.userAgent === 'string' ? message.userAgent : undefined,
        connectedAt: new Date().toISOString(),
      };
      return;
    }

    const id = message?.id;
    if (typeof id !== 'string') return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(message);
  }

  command(action, params = {}) {
    if (!this.socket) {
      return Promise.reject(new Error('web-access browser extension is not connected'));
    }

    const id = String(++this.nextId);
    const payload = { id, action, ...params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Extension command timed out: ${action}`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}

export function createHttpHandler({ bridge }) {
  return async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    setCorsHeaders(req, res);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.method === 'OPTIONS') {
      if (!isAllowedHttpOrigin(req.headers.origin)) {
        res.statusCode = 403;
        res.end();
        return;
      }
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      if (!isAllowedHttpOrigin(req.headers.origin)) {
        res.statusCode = 403;
        writeJson(res, { error: 'forbidden_origin' });
        return;
      }

      const pathname = url.pathname;
      if (pathname === '/health') {
        writeJson(res, {
          status: 'ok',
          backend: 'webext',
          connected: bridge.isConnected(),
          extension: bridge.extension,
        });
        return;
      }

      if (pathname === '/targets') {
        writeJson(res, await unwrapBridgeResult(bridge.command('targets')));
        return;
      }

      if (pathname === '/new') {
        requireMethod(req, 'POST');
        const targetUrl = (await readBody(req)).trim() || 'about:blank';
        writeJson(res, await unwrapBridgeResult(bridge.command('new', { url: targetUrl })));
        return;
      }

      if (pathname === '/navigate') {
        requireMethod(req, 'POST');
        const target = requireTarget(url);
        const targetUrl = (await readBody(req)).trim();
        writeJson(res, await unwrapBridgeResult(bridge.command('navigate', { target, url: targetUrl })));
        return;
      }

      if (pathname === '/back') {
        const target = requireTarget(url);
        writeJson(res, await unwrapBridgeResult(bridge.command('back', { target })));
        return;
      }

      if (pathname === '/close') {
        const target = requireTarget(url);
        writeJson(res, await unwrapBridgeResult(bridge.command('close', { target })));
        return;
      }

      if (pathname === '/info') {
        const target = requireTarget(url);
        writeJson(res, await unwrapBridgeResult(bridge.command('info', { target })));
        return;
      }

      if (pathname === '/eval') {
        requireMethod(req, 'POST');
        const target = requireTarget(url);
        const code = await readBody(req);
        writeJson(res, await unwrapBridgeResult(bridge.command('eval', { target, code })));
        return;
      }

      if (pathname === '/click') {
        requireMethod(req, 'POST');
        const target = requireTarget(url);
        const selector = await readBody(req);
        writeJson(res, await unwrapBridgeResult(bridge.command('click', { target, selector })));
        return;
      }

      if (pathname === '/clickAt') {
        requireMethod(req, 'POST');
        const target = requireTarget(url);
        const selector = await readBody(req);
        writeJson(res, await unwrapBridgeResult(bridge.command('clickAt', { target, selector })));
        return;
      }

      if (pathname === '/setFiles') {
        requireMethod(req, 'POST');
        const target = requireTarget(url);
        const payload = JSON.parse(await readBody(req));
        writeJson(res, await unwrapBridgeResult(bridge.command('setFiles', { target, ...payload })));
        return;
      }

      if (pathname === '/scroll') {
        const target = requireTarget(url);
        const y = url.searchParams.has('y') ? Number(url.searchParams.get('y')) : undefined;
        const direction = url.searchParams.get('direction') || undefined;
        writeJson(res, await unwrapBridgeResult(bridge.command('scroll', { target, y, direction })));
        return;
      }

      if (pathname === '/screenshot') {
        const target = requireTarget(url);
        const file = url.searchParams.get('file');
        const result = await unwrapBridgeResult(bridge.command('screenshot', { target }));
        if (file && typeof result.data === 'string') {
          await fs.writeFile(file, Buffer.from(result.data, 'base64'));
          writeJson(res, { file, bytes: Buffer.byteLength(result.data, 'base64') });
        } else {
          writeJson(res, result);
        }
        return;
      }

      res.statusCode = 404;
      writeJson(res, {
        error: 'unknown_endpoint',
        endpoints: {
          '/health': 'GET',
          '/targets': 'GET',
          '/new': 'POST body=URL',
          '/navigate?target=': 'POST body=URL',
          '/eval?target=': 'POST body=JS',
          '/click?target=': 'POST body=selector',
          '/clickAt?target=': 'POST body=selector',
          '/setFiles?target=': 'POST body=json',
          '/scroll?target=': 'GET',
          '/screenshot?target=&file=': 'GET',
          '/close?target=': 'GET',
        },
      });
    } catch (error) {
      res.statusCode = error.statusCode || 500;
      writeJson(res, { error: error.message || String(error) });
    }
  };
}

export function handleWebSocketUpgrade(req, socket, head, bridge) {
  if (req.url !== '/ext') {
    socket.destroy();
    return;
  }
  if (!isAllowedExtensionOrigin(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return;
  }

  const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));

  const reader = new WebSocketFrameReader();
  const peer = {
    label: req.headers['user-agent'] || 'web-access-extension',
    send: (payload) => socket.write(encodeTextFrame(payload)),
    close: () => socket.destroy(),
  };
  bridge.attach(peer);
  if (head?.length) {
    for (const message of reader.push(head)) bridge.receive(message);
  }
  socket.on('data', (chunk) => {
    for (const message of reader.push(chunk)) bridge.receive(message);
  });
  socket.on('close', () => bridge.detach(peer));
  socket.on('error', () => bridge.detach(peer));
}

export class WebSocketFrameReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const messages = [];

    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) break;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) break;
        const big = this.buffer.readBigUInt64BE(offset);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large');
        length = Number(big);
        offset += 8;
      }

      const maskOffset = offset;
      const payloadOffset = masked ? offset + 4 : offset;
      const frameLength = payloadOffset + length;
      if (this.buffer.length < frameLength) break;

      let payload = this.buffer.subarray(payloadOffset, frameLength);
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      this.buffer = this.buffer.subarray(frameLength);

      if (opcode === 0x8) continue;
      if (opcode !== 0x1) continue;
      messages.push(payload.toString('utf8'));
    }

    return messages;
  }
}

export function encodeTextFrame(text, { masked = false } = {}) {
  const payload = Buffer.from(String(text), 'utf8');
  const headerLength = payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10;
  const maskLength = masked ? 4 : 0;
  const frame = Buffer.alloc(headerLength + maskLength + payload.length);

  frame[0] = 0x81;
  if (payload.length < 126) {
    frame[1] = payload.length | (masked ? 0x80 : 0);
  } else if (payload.length <= 0xffff) {
    frame[1] = 126 | (masked ? 0x80 : 0);
    frame.writeUInt16BE(payload.length, 2);
  } else {
    frame[1] = 127 | (masked ? 0x80 : 0);
    frame.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  const payloadOffset = headerLength + maskLength;
  if (masked) {
    const mask = crypto.randomBytes(4);
    mask.copy(frame, headerLength);
    for (let i = 0; i < payload.length; i++) frame[payloadOffset + i] = payload[i] ^ mask[i % 4];
  } else {
    payload.copy(frame, payloadOffset);
  }
  return frame;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function unwrapBridgeResult(promise) {
  const result = await promise;
  if (result?.ok === false) {
    const error = new Error(result.error || result.errorCode || 'extension_command_failed');
    error.statusCode = 502;
    throw error;
  }
  if ('value' in result) return { value: result.value };
  if ('data' in result && Object.keys(result).length <= 3) return result.data;
  const { id, ok, ...rest } = result || {};
  return rest;
}

function requireMethod(req, method) {
  if (req.method !== method) {
    const error = new Error(`method_not_allowed: use ${method}`);
    error.statusCode = 405;
    throw error;
  }
}

function requireTarget(url) {
  const target = url.searchParams.get('target');
  if (!target) {
    const error = new Error('missing target');
    error.statusCode = 400;
    throw error;
  }
  return target;
}

function writeJson(res, value) {
  res.end(JSON.stringify(value, null, 2));
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (isAllowedHttpOrigin(origin) && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

function isAllowedHttpOrigin(origin) {
  return origin === undefined || isAllowedExtensionOrigin(origin);
}

function isAllowedExtensionOrigin(origin) {
  return typeof origin === 'string' && EXTENSION_ORIGIN_RE.test(origin);
}
