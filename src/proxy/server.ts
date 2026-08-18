import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RefractConfig } from '../config.js';
import { createForwarder } from './forward.js';
import { LifecycleTracker } from './lifecycle.js';

export interface ListenerAddress {
  host: string;
  port: number;
}

export interface RefractServer {
  lifecycle: LifecycleTracker;
  start(): Promise<{ data: ListenerAddress; admin: ListenerAddress }>;
  close(): Promise<void>;
}

function listen(server: http.Server, host: string, port: number): Promise<ListenerAddress> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo;
      resolve({ host: address.address, port: address.port });
    });
  });
}

function closeServer(server: http.Server, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => server.closeAllConnections(), graceMs);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections();
  });
}

function authorized(request: http.IncomingMessage, token: Buffer | null): boolean {
  if (token === null) return true;
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return false;
  const candidate = Buffer.from(authorization.slice(7));
  return candidate.length === token.length && crypto.timingSafeEqual(candidate, token);
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  response.end(body);
}

export function createRefractServer(config: RefractConfig): RefractServer {
  const lifecycle = new LifecycleTracker();
  const forwarder = createForwarder(config, lifecycle);
  let closing = false;
  const dataServer = http.createServer((request, response) => forwarder.handle(request, response));
  const adminServer = http.createServer((request, response) => {
    const pathname = request.url?.split('?', 1)[0];
    if (request.method === 'GET' && pathname === '/health/live') {
      json(response, 200, { status: 'live' });
      return;
    }
    if (request.method === 'GET' && pathname === '/health/ready') {
      json(response, closing ? 503 : 200, { status: closing ? 'draining' : 'ready' });
      return;
    }
    if (!authorized(request, config.admin.token)) {
      response.setHeader('www-authenticate', 'Bearer');
      json(response, 401, { error: { code: 'admin_unauthorized' } });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/v1/transport') {
      json(response, 200, lifecycle.snapshot());
      return;
    }
    json(response, 404, { error: { code: 'not_found' } });
  });

  dataServer.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  adminServer.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return {
    lifecycle,
    async start() {
      const data = await listen(dataServer, config.data.host, config.data.port);
      try {
        const admin = await listen(adminServer, config.admin.host, config.admin.port);
        return { data, admin };
      } catch (error) {
        await closeServer(dataServer, config.timeouts.shutdownGraceMs);
        throw error;
      }
    },
    async close() {
      closing = true;
      await Promise.all([
        closeServer(dataServer, config.timeouts.shutdownGraceMs),
        closeServer(adminServer, config.timeouts.shutdownGraceMs),
      ]);
      forwarder.destroy();
    },
  };
}
