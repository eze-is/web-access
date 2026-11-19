// CDP Proxy 监听端点解析 - 被 cdp-proxy、check-deps、proxy-maintenance 共享。
// 默认只监听回环；局域网访问必须显式设置 CDP_PROXY_HOST=0.0.0.0。

import net from 'node:net';
import os from 'node:os';
import { readConfig } from './browser-discovery.mjs';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3456;

function stripBrackets(value) {
  const host = String(value).trim();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function validateHost(raw) {
  const host = stripBrackets(raw);
  if (!host) throw new Error('CDP_PROXY_HOST 不能为空');
  if (host.includes('://') || /[\s/]/.test(host)) {
    throw new Error('CDP_PROXY_HOST 必须是 IP 或主机名，不能包含协议、路径或空白');
  }
  if (net.isIP(host) === 0 && !/^[A-Za-z0-9._-]+$/.test(host)) {
    throw new Error('CDP_PROXY_HOST 必须是合法的 IP 或主机名');
  }
  return host;
}

// 返回监听用 host/port，以及本机健康检查用的回环地址和 URL authority。
export function resolveProxyEndpoint(config = readConfig(), env = process.env) {
  const rawPort = String(env.CDP_PROXY_PORT ?? config.CDP_PROXY_PORT ?? DEFAULT_PORT).trim();
  if (!/^\d+$/.test(rawPort)) throw new Error('CDP_PROXY_PORT 必须是 1 到 65535 的十进制整数');
  const port = Number(rawPort);
  if (port < 1 || port > 65535) throw new Error('CDP_PROXY_PORT 必须是 1 到 65535 的十进制整数');

  const host = validateHost(env.CDP_PROXY_HOST ?? config.CDP_PROXY_HOST ?? DEFAULT_HOST);
  const localHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const authority = localHost.includes(':') ? `[${localHost}]` : localHost;
  return { host, port, localHost, authority };
}

// /shutdown 只接受来自本机地址的请求；自定义监听 IP 时也允许本机通过该 IP 维护。
export function isLocalAddress(address, interfaces = os.networkInterfaces()) {
  if (!address) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (normalized === '127.0.0.1' || normalized === '::1') return true;
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.address === normalized) return true;
    }
  }
  return false;
}
