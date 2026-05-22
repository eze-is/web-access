#!/usr/bin/env node
// Browser-extension proxy for web-access.
// Exposes a CDP-proxy-compatible HTTP API and talks to the extension over WebSocket.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  ExtensionBridge,
  createHttpHandler,
  handleWebSocketUpgrade,
} from './webext-proxy-lib.mjs';

const PORT = Number(process.env.WEB_ACCESS_EXT_PROXY_PORT || 3457);
const bridge = new ExtensionBridge();
const server = http.createServer(createHttpHandler({ bridge }));

server.on('upgrade', (req, socket, head) => {
  handleWebSocketUpgrade(req, socket, head, bridge);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[WebExt Proxy] listening on http://127.0.0.1:${PORT}`);
  console.log(`[WebExt Proxy] extension path: ${path.resolve(import.meta.dirname, '..', 'extension')}`);
  console.log(`[WebExt Proxy] log: ${path.join(os.tmpdir(), 'web-access-webext-proxy.log')}`);
});
