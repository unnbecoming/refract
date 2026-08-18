import * as http from 'node:http';
import * as zlib from 'node:zlib';
import { afterEach, describe, expect, test } from 'vitest';
import { createRefractServer, type RefractServer } from '../src/proxy/server.js';
import { close, listen, request, testConfig } from './helpers.js';

const openServers: http.Server[] = [];
const openRefract: RefractServer[] = [];

afterEach(async () => {
  await Promise.all(openRefract.splice(0).map((server) => server.close()));
  await Promise.all(openServers.splice(0).map(close));
});

function values(rawHeaders: readonly string[], name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name.toLowerCase()) result.push(rawHeaders[index + 1] ?? '');
  }
  return result;
}

describe('fixed-route transport', () => {
  test('preserves request/response bodies, query, status, encoding, and duplicate end-to-end headers on all surfaces', async () => {
    const received: Array<{ url: string; body: Buffer; rawHeaders: string[] }> = [];
    const upstream = http.createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        received.push({ url: incoming.url ?? '', body: Buffer.concat(chunks), rawHeaders: incoming.rawHeaders });
        response.writeHead(207, 'Recorded', [
          'Content-Type', 'application/octet-stream',
          'Content-Encoding', 'gzip',
          'Content-Length', String(chunks.reduce((sum, chunk) => sum + chunk.length, 0)),
          'X-Duplicate', 'response-one',
          'X-Duplicate', 'response-two',
          'Connection', 'X-Remove-Response',
          'X-Remove-Response', 'not-forwarded',
        ]);
        response.end(Buffer.concat(chunks));
      });
    });
    openServers.push(upstream);
    const origin = await listen(upstream);
    const proxy = createRefractServer(testConfig(origin));
    openRefract.push(proxy);
    const addresses = await proxy.start();
    const body = zlib.gzipSync(Buffer.from('{"unusual spacing":  true, "n": 1}\n'));
    const paths = ['/v1/messages', '/v1/chat/completions', '/v1/responses'];

    for (const [index, pathname] of paths.entries()) {
      const result = await request(new URL(`${pathname}?trace=${index}&raw=%2F`, `http://127.0.0.1:${addresses.data.port}`), {
        method: 'POST',
        headers: [
          'Host', 'caller.invalid',
          'Authorization', 'Bearer caller-placeholder',
          'X-Api-Key', 'caller-api-placeholder',
          'Content-Type', 'application/json',
          'Content-Encoding', 'gzip',
          'Content-Length', String(body.length),
          'X-Duplicate', 'request-one',
          'X-Duplicate', 'request-two',
          'Connection', 'X-Remove-Request',
          'X-Remove-Request', 'not-forwarded',
        ],
        body,
      });
      expect(result.status).toBe(207);
      expect(result.statusMessage).toBe('Recorded');
      expect(result.body).toEqual(body);
      expect(values(result.rawHeaders, 'x-duplicate')).toEqual(['response-one', 'response-two']);
      expect(values(result.rawHeaders, 'x-remove-response')).toEqual([]);
      expect(values(result.rawHeaders, 'content-encoding')).toEqual(['gzip']);
    }

    expect(received).toHaveLength(3);
    for (const [index, exchange] of received.entries()) {
      expect(exchange.url).toBe(`${paths[index]}?trace=${index}&raw=%2F`);
      expect(exchange.body).toEqual(body);
      expect(values(exchange.rawHeaders, 'x-duplicate')).toEqual(['request-one', 'request-two']);
      expect(values(exchange.rawHeaders, 'x-remove-request')).toEqual([]);
      expect(values(exchange.rawHeaders, 'host')).toEqual([origin.host]);
      if (index === 0) {
        expect(values(exchange.rawHeaders, 'x-api-key')).toEqual(['anthropic-test-secret']);
        expect(values(exchange.rawHeaders, 'authorization')).toEqual([]);
      } else {
        expect(values(exchange.rawHeaders, 'authorization')).toEqual(['Bearer openai-test-secret']);
        expect(values(exchange.rawHeaders, 'x-api-key')).toEqual([]);
      }
      expect(exchange.rawHeaders.join('\n')).not.toContain('caller-placeholder');
      expect(exchange.rawHeaders.join('\n')).not.toContain('caller-api-placeholder');
    }
  });

  test('forwards the first response chunk before upstream completion', async () => {
    let upstreamFinished = false;
    const upstream = http.createServer((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('event: first\ndata: one\n\n');
      setTimeout(() => {
        upstreamFinished = true;
        response.end('event: second\ndata: two\n\n');
      }, 120);
    });
    openServers.push(upstream);
    const origin = await listen(upstream);
    const proxy = createRefractServer(testConfig(origin));
    openRefract.push(proxy);
    const addresses = await proxy.start();

    await new Promise<void>((resolve, reject) => {
      const outgoing = http.request(`http://127.0.0.1:${addresses.data.port}/v1/responses`, { method: 'POST' }, (incoming) => {
        incoming.once('data', (chunk: Buffer) => {
          try {
            expect(chunk.toString()).toContain('event: first');
            expect(upstreamFinished).toBe(false);
            incoming.resume();
            incoming.once('end', resolve);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
      outgoing.once('error', reject);
      outgoing.end('{}');
    });
  });

  test('reuses an upstream keep-alive connection across sequential calls', async () => {
    const sockets = new Set<unknown>();
    const upstream = http.createServer((incoming, response) => {
      sockets.add(incoming.socket);
      response.end('{}');
    });
    openServers.push(upstream);
    const origin = await listen(upstream);
    const proxy = createRefractServer(testConfig(origin));
    openRefract.push(proxy);
    const addresses = await proxy.start();
    const endpoint = new URL('/v1/responses', `http://127.0.0.1:${addresses.data.port}`);

    expect((await request(endpoint, { method: 'POST', body: Buffer.from('{}') })).status).toBe(200);
    expect((await request(endpoint, { method: 'POST', body: Buffer.from('{}') })).status).toBe(200);
    expect(sockets.size).toBe(1);
  });

  test('fails closed for unknown methods, paths, and absolute-form targets without contacting upstream', async () => {
    let contacts = 0;
    const upstream = http.createServer((_incoming, response) => {
      contacts += 1;
      response.end('unexpected');
    });
    openServers.push(upstream);
    const origin = await listen(upstream);
    const proxy = createRefractServer(testConfig(origin));
    openRefract.push(proxy);
    const addresses = await proxy.start();
    const base = `http://127.0.0.1:${addresses.data.port}`;

    expect((await request(new URL('/v1/unknown', base), { method: 'POST' })).status).toBe(404);
    expect((await request(new URL('/v1/messages', base), { method: 'GET' })).status).toBe(405);
    expect((await request(new URL('/', base), { method: 'POST', path: 'http://attacker.test/v1/messages' })).status).toBe(400);
    expect(contacts).toBe(0);
  });

  test('aborts upstream and records cancellation when the downstream disconnects', async () => {
    let upstreamClosedResolve: (() => void) | undefined;
    const upstreamClosed = new Promise<void>((resolve) => { upstreamClosedResolve = resolve; });
    const upstream = http.createServer((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const timer = setInterval(() => response.write('data: still-running\n\n'), 10);
      response.once('close', () => {
        clearInterval(timer);
        upstreamClosedResolve?.();
      });
    });
    openServers.push(upstream);
    const origin = await listen(upstream);
    const proxy = createRefractServer(testConfig(origin));
    openRefract.push(proxy);
    const addresses = await proxy.start();

    await new Promise<void>((resolve, reject) => {
      const outgoing = http.request(`http://127.0.0.1:${addresses.data.port}/v1/messages`, { method: 'POST' }, (incoming) => {
        incoming.once('data', () => {
          incoming.destroy();
          resolve();
        });
      });
      outgoing.once('error', reject);
      outgoing.end('{}');
    });
    await upstreamClosed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(proxy.lifecycle.snapshot().recent[0]?.state).toBe('downstream_cancelled');
  });

  test('propagates downstream backpressure instead of buffering a whole response', async () => {
    const chunk = Buffer.alloc(16 * 1024, 0x5a);
    const chunkCount = 512;
    let backpressuredResolve: (() => void) | undefined;
    const backpressured = new Promise<void>((resolve) => { backpressuredResolve = resolve; });
    const upstream = http.createServer((_incoming, response) => {
      let written = 0;
      const write = () => {
        while (written < chunkCount) {
          written += 1;
          if (!response.write(chunk)) {
            backpressuredResolve?.();
            response.once('drain', write);
            return;
          }
        }
        response.end();
      };
      write();
    });
    openServers.push(upstream);
    const origin = await listen(upstream);
    const proxy = createRefractServer(testConfig(origin));
    openRefract.push(proxy);
    const addresses = await proxy.start();

    const received = await new Promise<number>((resolve, reject) => {
      const outgoing = http.request(`http://127.0.0.1:${addresses.data.port}/v1/responses`, { method: 'POST' }, (incoming) => {
        let bytes = 0;
        incoming.pause();
        incoming.on('data', (part: Buffer) => { bytes += part.length; });
        incoming.once('end', () => resolve(bytes));
        setTimeout(() => incoming.resume(), 75);
      });
      outgoing.once('error', reject);
      outgoing.end('{}');
    });
    await backpressured;
    expect(received).toBe(chunk.length * chunkCount);
  });

  test('classifies an upstream that stalls after response headers as a stream timeout', async () => {
    const upstream = http.createServer((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
    });
    openServers.push(upstream);
    const origin = await listen(upstream);
    const config = testConfig(origin);
    config.timeouts.upstreamIdleMs = 30;
    const proxy = createRefractServer(config);
    openRefract.push(proxy);
    const addresses = await proxy.start();

    await new Promise<void>((resolve, reject) => {
      const outgoing = http.request(`http://127.0.0.1:${addresses.data.port}/v1/responses`, { method: 'POST' }, (incoming) => {
        incoming.resume();
        incoming.once('aborted', resolve);
        incoming.once('error', resolve);
        incoming.once('end', () => reject(new Error('stalled upstream unexpectedly completed')));
      });
      outgoing.once('error', resolve);
      outgoing.end('{}');
      setTimeout(() => reject(new Error('idle timeout did not terminate the response')), 1_000).unref();
    });
    expect(proxy.lifecycle.snapshot().recent[0]).toMatchObject({
      state: 'upstream_stream_error',
      errorCode: 'UPSTREAM_IDLE_TIMEOUT',
    });
  });

  test('times out stalled upstream headers and records a classified connect failure', async () => {
    const upstream = http.createServer(() => undefined);
    openServers.push(upstream);
    const origin = await listen(upstream);
    const config = testConfig(origin);
    config.timeouts.upstreamHeadersMs = 30;
    const proxy = createRefractServer(config);
    openRefract.push(proxy);
    const addresses = await proxy.start();

    const result = await request(new URL('/v1/messages', `http://127.0.0.1:${addresses.data.port}`), {
      method: 'POST',
      body: Buffer.from('{}'),
    });
    expect(result.status).toBe(502);
    const payload = JSON.parse(result.body.toString()) as { error: { code: string } };
    expect(payload.error.code).toBe('UPSTREAM_HEADERS_TIMEOUT');
    expect(proxy.lifecycle.snapshot().recent[0]).toMatchObject({
      state: 'upstream_connect_error',
      errorCode: 'UPSTREAM_HEADERS_TIMEOUT',
    });
  });

  test('bounds declared and chunked request bodies without contacting or completing upstream', async () => {
    let contacts = 0;
    const upstream = http.createServer((incoming, response) => { contacts += 1; incoming.resume(); incoming.on('end', () => response.end('{}')); });
    openServers.push(upstream);
    const origin = await listen(upstream);
    const config = testConfig(origin);
    config.limits.maxRequestBodyBytes = 8;
    const proxy = createRefractServer(config);
    openRefract.push(proxy);
    const addresses = await proxy.start();
    const endpoint = new URL('/v1/responses', `http://127.0.0.1:${addresses.data.port}`);
    expect((await request(endpoint, { method: 'POST', body: Buffer.alloc(9) })).status).toBe(413);
    expect(contacts).toBe(0);

    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = http.request(endpoint, { method: 'POST', headers: { 'transfer-encoding': 'chunked' } }, (incoming) => { incoming.resume(); incoming.once('end', () => resolve(incoming.statusCode ?? 0)); });
      outgoing.once('error', reject);
      outgoing.write(Buffer.alloc(5));
      outgoing.end(Buffer.alloc(5));
    });
    expect(status).toBe(413);
    expect(proxy.lifecycle.snapshot().recent[0]).toMatchObject({ state: 'downstream_cancelled', errorCode: 'REQUEST_BODY_LIMIT' });
  });

  test('rejects concurrency saturation without disturbing the active stream', async () => {
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const upstream = http.createServer((incoming, response) => { incoming.resume(); void hold.then(() => response.end('{}')); });
    openServers.push(upstream);
    const origin = await listen(upstream);
    const config = testConfig(origin);
    config.limits.maxConcurrentRequests = 1;
    const proxy = createRefractServer(config);
    openRefract.push(proxy);
    const addresses = await proxy.start();
    const endpoint = new URL('/v1/responses', `http://127.0.0.1:${addresses.data.port}`);
    const first = request(endpoint, { method: 'POST', body: Buffer.from('{}') });
    for (let index = 0; index < 100 && proxy.lifecycle.activeCount === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    const saturated = await request(endpoint, { method: 'POST', body: Buffer.from('{}') });
    expect(saturated.status).toBe(503);
    expect(values(saturated.rawHeaders, 'retry-after')).toEqual(['1']);
    release?.();
    expect((await first).status).toBe(200);
  });

  test('keeps forwarding readiness healthy when the durable recorder cannot start', async () => {
    const upstream = http.createServer((_incoming, response) => response.end('{}'));
    openServers.push(upstream);
    const origin = await listen(upstream);
    const config = testConfig(origin);
    config.durablePath = '/dev/null/refract.db';
    const proxy = createRefractServer(config);
    openRefract.push(proxy);
    const addresses = await proxy.start();
    const admin = `http://127.0.0.1:${addresses.admin.port}`;
    const ready = await request(new URL('/health/ready', admin));
    expect(ready.status).toBe(200);
    expect(JSON.parse(ready.body.toString())).toEqual({ status: 'ready', recorder: 'degraded' });
    expect((await request(new URL('/health/recording', admin))).status).toBe(503);
    expect((await request(new URL('/v1/responses', `http://127.0.0.1:${addresses.data.port}`), { method: 'POST', body: Buffer.from('{}') })).status).toBe(200);
  });

  test('binds a separate admin listener with health and bearer-gated state', async () => {
    const upstream = http.createServer((_incoming, response) => response.end('{}'));
    openServers.push(upstream);
    const origin = await listen(upstream);
    const token = Buffer.from('this-is-a-long-admin-token');
    const proxy = createRefractServer(testConfig(origin, token));
    openRefract.push(proxy);
    const addresses = await proxy.start();
    const base = `http://127.0.0.1:${addresses.admin.port}`;

    expect((await request(new URL('/health/live', base))).status).toBe(200);
    expect((await request(new URL('/api/v1/transport', base))).status).toBe(401);
    const state = await request(new URL('/api/v1/transport', base), { headers: { authorization: `Bearer ${token.toString()}` } });
    expect(state.status).toBe(200);
    expect(JSON.parse(state.body.toString())).toEqual({
      active: [],
      recent: [],
      durable: { available: true, startupFailed: false, recoveredRequests: 0 },
      raw: { enabled: false, available: false, startupFailed: false },
      events: { clients: 0, dropped: 0, sequence: 0 },
    });
    expect(addresses.admin.port).not.toBe(addresses.data.port);
  });
});
