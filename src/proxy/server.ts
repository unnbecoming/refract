import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { RefractConfig } from '../config.js';
import { createForwarder } from './forward.js';
import { LifecycleTracker } from './lifecycle.js';
import { RawCaptureStore } from '../storage/raw-store.js';
import { DurableStore } from '../storage/durable-store.js';
import { LiveEventHub } from '../api-events.js';
import { createAdminApi } from '../admin-api.js';
import { renderMetrics } from '../metrics.js';
import { log } from '../logging.js';

export interface ListenerAddress {
  host: string;
  port: number;
}

export interface RefractServer {
  lifecycle: LifecycleTracker;
  events: LiveEventHub;
  raw: RawCaptureStore | null;
  durable: DurableStore | null;
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

function serveUi(pathname: string, response: http.ServerResponse): boolean {
  if (pathname.startsWith('/api/') || pathname === '/metrics' || pathname.startsWith('/health/')) return false;
  const root = path.resolve(process.cwd(), 'dist/ui');
  const relative = pathname.startsWith('/assets/') ? pathname.slice(1) : 'index.html';
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(`${root}${path.sep}`) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) return false;
  const extension = path.extname(filename);
  const contentType = extension === '.html' ? 'text/html; charset=utf-8'
    : extension === '.js' ? 'text/javascript; charset=utf-8'
      : extension === '.css' ? 'text/css; charset=utf-8'
        : 'application/octet-stream';
  const body = fs.readFileSync(filename);
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': String(body.length),
    'cache-control': extension === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
  return true;
}

export function createRefractServer(config: RefractConfig): RefractServer {
  const events = new LiveEventHub();
  const lifecycle = new LifecycleTracker((record) => {
    events.publish('lifecycle', record);
    if (['completed', 'upstream_connect_error', 'upstream_stream_error', 'downstream_cancelled'].includes(record.state)) {
      log.info({ requestId: record.id, provider: record.provider, surface: record.surface, state: record.state, httpStatus: record.httpStatus, ttfbMs: record.ttfbMs, totalMs: record.totalMs, errorCode: record.errorCode }, 'request finalized');
    }
  });
  let raw: RawCaptureStore | null = null;
  let durable: DurableStore | null = null;
  let rawStartupFailed = false;
  let durableStartupFailed = false;
  let recoveredRequests = 0;
  if (config.raw) {
    try { raw = new RawCaptureStore(config.raw); }
    catch { rawStartupFailed = true; }
  }
  const forwarder = createForwarder(config, lifecycle, () => raw, () => durable, (type, data) => events.publish(type, data));
  let closing = false;
  let pruneTimer: NodeJS.Timeout | null = null;
  const dataServer = http.createServer((request, response) => forwarder.handle(request, response));
  const adminApi = createAdminApi({
    config,
    lifecycle,
    events,
    durable: () => durable,
    raw: () => raw,
    durableStatus: () => ({ startupFailed: durableStartupFailed, recoveredRequests }),
    rawStatus: () => ({ startupFailed: rawStartupFailed }),
  });
  const adminServer = http.createServer((request, response) => {
    const pathname = request.url?.split('?', 1)[0];
    if (request.method === 'GET' && pathname === '/health/live') {
      json(response, 200, { status: 'live' });
      return;
    }
    if (request.method === 'GET' && pathname === '/health/ready') {
      const ready = !closing && durable !== null;
      json(response, ready ? 200 : 503, { status: closing ? 'draining' : ready ? 'ready' : 'degraded' });
      return;
    }
    if (request.method === 'GET' && pathname && serveUi(pathname, response)) return;
    if (!authorized(request, config.admin.token)) {
      response.setHeader('www-authenticate', 'Bearer');
      json(response, 401, { error: { code: 'admin_unauthorized' } });
      return;
    }
    if (request.method === 'GET' && pathname === '/metrics') {
      void renderMetrics({ config, lifecycle, durable, raw, events }).then((body) => {
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store' });
        response.end(body);
      }).catch(() => json(response, 503, { error: { code: 'metrics_unavailable' } }));
      return;
    }
    void adminApi(request, response).then((handled) => {
      if (!handled && !response.headersSent) json(response, 404, { error: { code: 'not_found' } });
    });
  });

  dataServer.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  adminServer.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return {
    lifecycle,
    events,
    get raw() { return raw; },
    get durable() { return durable; },
    async start() {
      try {
        durable = await DurableStore.open(config.durablePath);
        recoveredRequests = await durable.recoverActive();
      } catch {
        durable = null;
        durableStartupFailed = true;
      }
      if (raw) {
        try { await raw.ready(); }
        catch { raw = null; rawStartupFailed = true; }
      }
      const data = await listen(dataServer, config.data.host, config.data.port);
      try {
        const admin = await listen(adminServer, config.admin.host, config.admin.port);
        if (raw && config.raw) {
          void raw.prune();
          pruneTimer = setInterval(() => { void raw?.prune(); }, config.raw.pruneIntervalSeconds * 1_000);
          pruneTimer.unref();
        }
        return { data, admin };
      } catch (error) {
        await closeServer(dataServer, config.timeouts.shutdownGraceMs);
        throw error;
      }
    },
    async close() {
      closing = true;
      if (pruneTimer) clearInterval(pruneTimer);
      events.close();
      await Promise.all([
        closeServer(dataServer, config.timeouts.shutdownGraceMs),
        closeServer(adminServer, config.timeouts.shutdownGraceMs),
      ]);
      await forwarder.drain();
      forwarder.destroy();
      await Promise.all([raw?.close(), durable?.close()]);
    },
  };
}
