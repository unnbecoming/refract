import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { createRefractServer, type RefractServer } from '../src/proxy/server.js';
import { close, listen, request, testConfig } from './helpers.js';

const servers: http.Server[] = [];
const proxies: RefractServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(servers.splice(0).map(close));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function rawConfig(origin: URL) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-raw-integration-'));
  directories.push(directory);
  const config = testConfig(origin);
  config.raw = {
    path: path.join(directory, 'raw.db'), retentionHours: 168, pruneIntervalSeconds: 60,
    deleteBatchSize: 10, maxDbBytes: 64 * 1024 * 1024, targetDbBytes: 48 * 1024 * 1024,
    maxExchangeBytes: 1024 * 1024, blockBytes: 8, maxQueuedWrites: 100,
  };
  return { config, directory };
}

function physicalBytes(directory: string): Buffer {
  const names = ['raw.db', 'raw.db-wal', 'raw.db-shm'];
  return Buffer.concat(names.filter((name) => fs.existsSync(path.join(directory, name))).map((name) => fs.readFileSync(path.join(directory, name))));
}

describe('wired raw capture', () => {
  test('records exact bodies while provider and caller credentials remain absent from SQLite files', async () => {
    let authorization = '';
    const upstream = http.createServer((incoming, response) => {
      authorization = incoming.headers.authorization ?? '';
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(Buffer.concat([Buffer.from('reply:'), ...chunks]));
      });
    });
    servers.push(upstream);
    const origin = await listen(upstream);
    const { config, directory } = rawConfig(origin);
    const proxy = createRefractServer(config);
    proxies.push(proxy);
    const addresses = await proxy.start();
    const requestBody = Buffer.from('safe-request-body');
    const result = await request(new URL('/v1/responses', `http://127.0.0.1:${addresses.data.port}`), {
      method: 'POST',
      headers: { authorization: 'Bearer caller-placeholder-secret', 'content-length': String(requestBody.length) },
      body: requestBody,
    });
    expect(result.body).toEqual(Buffer.from('reply:safe-request-body'));
    expect(authorization).toBe('Bearer openai-test-secret');
    const id = proxy.lifecycle.snapshot().recent[0]?.id;
    expect(id).toBeDefined();
    await proxy.raw?.flush();
    expect(await proxy.raw?.reconstruct(id ?? '', 'request')).toEqual(requestBody);
    expect(await proxy.raw?.reconstruct(id ?? '', 'response')).toEqual(result.body);
    expect(await proxy.raw?.getExchange(id ?? '')).toMatchObject({ capture_state: 'complete' });
    const physical = physicalBytes(directory);
    for (const canary of ['openai-test-secret', 'caller-placeholder-secret']) {
      expect(physical.includes(Buffer.from(canary))).toBe(false);
    }
  });

  test('a locked raw database cannot delay otherwise successful forwarding', async () => {
    const upstream = http.createServer((_incoming, response) => response.end('not-blocked'));
    servers.push(upstream);
    const origin = await listen(upstream);
    const { config } = rawConfig(origin);
    const proxy = createRefractServer(config);
    proxies.push(proxy);
    const addresses = await proxy.start();
    const locker = await open({ filename: config.raw!.path, driver: sqlite3.Database });
    await locker.exec('BEGIN IMMEDIATE');
    try {
      const started = performance.now();
      const result = await request(new URL('/v1/responses', `http://127.0.0.1:${addresses.data.port}`), { method: 'POST', body: Buffer.from('{}') });
      const elapsed = performance.now() - started;
      expect(result.body.toString()).toBe('not-blocked');
      expect(elapsed).toBeLessThan(100);
      expect(proxy.raw?.stats().pendingWrites).toBeGreaterThan(0);
    } finally {
      await locker.exec('ROLLBACK');
      await locker.close();
    }
    await proxy.raw?.flush();
    expect(proxy.raw?.stats().pendingWrites).toBe(0);
  });

  test('continues forwarding when raw SQLite cannot open at startup', async () => {
    const upstream = http.createServer((_incoming, response) => response.end('forwarded'));
    servers.push(upstream);
    const origin = await listen(upstream);
    const { config, directory } = rawConfig(origin);
    config.raw = { ...config.raw!, path: directory };
    const proxy = createRefractServer(config);
    proxies.push(proxy);
    const addresses = await proxy.start();
    const result = await request(new URL('/v1/messages', `http://127.0.0.1:${addresses.data.port}`), { method: 'POST', body: Buffer.from('{}') });
    expect(result.body.toString()).toBe('forwarded');
    expect(proxy.raw).toBeNull();
    const state = await request(new URL('/api/v1/transport', `http://127.0.0.1:${addresses.admin.port}`));
    expect(JSON.parse(state.body.toString())).toMatchObject({ raw: { enabled: true, available: false, startupFailed: true } });
  });

  test('forwards a secret-bearing response unchanged but drops its raw capture', async () => {
    const echoed = Buffer.from('the provider accidentally echoed openai-test-secret intact');
    const upstream = http.createServer((_incoming, response) => response.end(echoed));
    servers.push(upstream);
    const origin = await listen(upstream);
    const { config, directory } = rawConfig(origin);
    const proxy = createRefractServer(config);
    proxies.push(proxy);
    const addresses = await proxy.start();
    const result = await request(new URL('/v1/chat/completions', `http://127.0.0.1:${addresses.data.port}`), { method: 'POST', body: Buffer.from('{}') });
    expect(result.body).toEqual(echoed);
    const id = proxy.lifecycle.snapshot().recent[0]?.id ?? '';
    await proxy.raw?.flush();
    expect(await proxy.raw?.getExchange(id)).toMatchObject({ capture_state: 'dropped_secret' });
    expect(await proxy.raw?.reconstruct(id, 'response')).toEqual(Buffer.alloc(0));
    expect(physicalBytes(directory).includes(Buffer.from('openai-test-secret'))).toBe(false);
  });
});
