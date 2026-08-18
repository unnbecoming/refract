import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createRefractServer, type RefractServer } from '../src/proxy/server.js';
import { close, listen, request, testConfig } from './helpers.js';

const upstreams: http.Server[] = [];
const proxies: RefractServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(upstreams.splice(0).map(close));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temp(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-admin-'));
  directories.push(directory);
  return directory;
}

async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let index = 0; index < 200; index += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

function openSse(url: URL, headers: http.OutgoingHttpHeaders): Promise<string> {
  return new Promise((resolve, reject) => {
    const call = http.get(url, { headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.includes('\n\n')) { call.destroy(); resolve(body); }
      });
    });
    call.once('error', (error) => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error); });
  });
}

describe('admin observability API', () => {
  test('serves bounded durable inspection, raw retention, metrics, and live replay', async () => {
    let call = 0;
    const upstream = http.createServer((incoming, response) => {
      incoming.resume();
      incoming.on('end', () => {
        call += 1;
        const body = Buffer.from(JSON.stringify({
          id: `resp_${call}`,
          object: 'response',
          model: 'gpt-observe',
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `answer ${call}`, annotations: [] }] }],
          usage: { input_tokens: call + 1, output_tokens: call },
        }));
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) });
        response.end(body);
      });
    });
    upstreams.push(upstream);
    const origin = await listen(upstream);
    const directory = temp();
    const token = Buffer.from('admin-test-token');
    const config = testConfig(origin, token);
    config.durablePath = path.join(directory, 'durable.db');
    config.rawDownloadEnabled = true;
    config.raw = {
      path: path.join(directory, 'raw.db'), retentionHours: 1, pruneIntervalSeconds: 3600,
      deleteBatchSize: 10, maxDbBytes: 64 * 1024 * 1024, targetDbBytes: 48 * 1024 * 1024,
      maxExchangeBytes: 1024 * 1024, blockBytes: 32, maxQueuedWrites: 100,
    };
    const proxy = createRefractServer(config);
    proxies.push(proxy);
    const addresses = await proxy.start();
    const data = `http://127.0.0.1:${addresses.data.port}`;
    const admin = `http://127.0.0.1:${addresses.admin.port}`;
    const headers = { authorization: 'Bearer admin-test-token' };

    const firstWire = Buffer.from(JSON.stringify({ model: 'gpt-observe', input: 'first' }));
    await request(new URL('/v1/responses', data), { method: 'POST', headers: { 'content-type': 'application/json' }, body: firstWire });
    const firstId = proxy.lifecycle.snapshot().recent[0]?.id ?? '';
    await eventually(async () => (await proxy.durable?.getRequest(firstId))?.parse_status === 'parsed' ? firstId : undefined);
    await request(new URL('/v1/responses', data), { method: 'POST', body: Buffer.from(JSON.stringify({ model: 'gpt-observe', previous_response_id: 'resp_1', input: 'second' })) });
    const secondId = proxy.lifecycle.snapshot().recent[0]?.id ?? '';
    const secondRow = await eventually(async () => {
      const row = await proxy.durable?.getRequest(secondId);
      return row?.parse_status === 'parsed' ? row : undefined;
    });

    expect((await request(new URL('/api/v1/requests', admin))).status).toBe(401);
    const page = await request(new URL('/api/v1/requests?limit=1&provider=openai&surface=responses', admin), { headers });
    expect(page.status).toBe(200);
    const pageJson = JSON.parse(page.body.toString()) as { items: Array<Record<string, unknown>>; nextCursor: string };
    expect(pageJson.items).toHaveLength(1);
    expect(pageJson.items[0]?.raw_state).toBe('retained');
    expect(pageJson.nextCursor).toBeTruthy();
    const next = await request(new URL(`/api/v1/requests?limit=1&cursor=${encodeURIComponent(pageJson.nextCursor)}`, admin), { headers });
    expect((JSON.parse(next.body.toString()) as { items: unknown[] }).items).toHaveLength(1);
    expect((await request(new URL('/api/v1/requests?cursor=bad', admin), { headers })).status).toBe(400);

    const detail = JSON.parse((await request(new URL(`/api/v1/requests/${secondId}`, admin), { headers })).body.toString()) as Record<string, unknown>;
    expect(detail.parent_request_id).toBe(firstId);
    expect(detail.raw_state).toBe('retained');
    expect(Array.isArray(detail.occurrences)).toBe(true);
    const transcriptResult = await request(new URL(`/api/v1/requests/${secondId}/transcript`, admin), { headers });
    const transcript = JSON.parse(transcriptResult.body.toString()) as { tailId: string; items: unknown[] };
    expect(transcript.items).toHaveLength(4);
    expect((await request(new URL(`/api/v1/contexts/${transcript.tailId}/transcript`, admin), { headers })).status).toBe(200);
    expect((await request(new URL(`/api/v1/contexts/${'0'.repeat(64)}/transcript`, admin), { headers })).status).toBe(404);
    const lineage = JSON.parse((await request(new URL(`/api/v1/lineages/${secondId}`, admin), { headers })).body.toString()) as { items: unknown[] };
    expect(lineage.items).toHaveLength(2);

    const stats = JSON.parse((await request(new URL('/api/v1/stats?provider=openai&model=gpt-observe', admin), { headers })).body.toString()) as { summary: Record<string, number> };
    expect(stats.summary.requests).toBe(2);
    const system = JSON.parse((await request(new URL('/api/v1/system', admin), { headers })).body.toString()) as Record<string, unknown>;
    expect(system.status).toBe('healthy');
    const metrics = await request(new URL('/metrics', admin), { headers });
    expect(metrics.body.toString()).toContain('refract_request_duration_milliseconds_bucket');
    expect(metrics.body.toString()).not.toContain(secondId);

    const manifest = await request(new URL(`/api/v1/raw/${firstId}`, admin), { headers });
    const manifestJson = JSON.parse(manifest.body.toString()) as Record<string, unknown>;
    expect(manifestJson.raw_state).toBe('retained');
    const download = await request(new URL(`/api/v1/raw/${firstId}?direction=request`, admin), { headers });
    expect(download.body).toEqual(firstWire);

    for (let index = 0; index < 520; index += 1) proxy.events.publish('test', { index });
    const reset = await openSse(new URL('/api/v1/events?after=0', admin), headers);
    expect(reset).toContain('event: reset');
    const ahead = await openSse(new URL('/api/v1/events?after=999999', admin), headers);
    expect(ahead).toContain('cursor_ahead');

    await proxy.raw?.prune(Date.now() + 2 * 3_600_000);
    expect((await request(new URL(`/api/v1/raw/${firstId}`, admin), { headers })).status).toBe(410);
    expect((await request(new URL(`/api/v1/requests/${secondId}/transcript`, admin), { headers })).status).toBe(200);
    expect(secondRow.output_tail_id).toBeInstanceOf(Buffer);
  });

  test('keeps the raw route absent unless independently enabled', async () => {
    const upstream = http.createServer((_incoming, response) => response.end('{}'));
    upstreams.push(upstream);
    const origin = await listen(upstream);
    const proxy = createRefractServer(testConfig(origin));
    proxies.push(proxy);
    const addresses = await proxy.start();
    expect((await request(new URL('/api/v1/raw/missing', `http://127.0.0.1:${addresses.admin.port}`))).status).toBe(404);
  });
});
