import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { afterEach, describe, expect, test } from 'vitest';
import { createRefractServer, type RefractServer } from '../src/proxy/server.js';
import { replayRetainedRaw } from '../src/providers/recording.js';
import { DurableStore } from '../src/storage/durable-store.js';
import { close, listen, request, testConfig } from './helpers.js';

const servers: http.Server[] = [];
const proxies: RefractServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(servers.splice(0).map(close));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-recording-'));
  directories.push(directory);
  return directory;
}

async function eventually<T>(read: () => Promise<T | undefined>, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for durable observation');
}

function rawEnabledConfig(origin: URL, directory: string) {
  const config = testConfig(origin);
  config.durablePath = path.join(directory, 'durable.db');
  config.raw = {
    path: path.join(directory, 'raw.db'), retentionHours: 24, pruneIntervalSeconds: 60,
    deleteBatchSize: 10, maxDbBytes: 64 * 1024 * 1024, targetDbBytes: 48 * 1024 * 1024,
    maxExchangeBytes: 1024 * 1024, blockBytes: 32, maxQueuedWrites: 100,
  };
  return config;
}

describe('live canonical recording and replay', () => {
  test('links previous Responses ancestry, reconstructs the transcript, and replays raw idempotently', async () => {
    let call = 0;
    const upstream = http.createServer((_incoming, response) => {
      call += 1;
      const body = Buffer.from(JSON.stringify({
        id: `resp_${call}`,
        object: 'response',
        model: 'gpt-example',
        status: 'completed',
        output: [{ type: 'message', id: `msg_${call}`, role: 'assistant', content: [{ type: 'output_text', text: call === 1 ? 'one' : 'two', annotations: [] }] }],
        usage: { input_tokens: call * 2, output_tokens: call },
      }));
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) });
      response.end(body);
    });
    servers.push(upstream);
    const origin = await listen(upstream);
    const directory = temporaryDirectory();
    const config = rawEnabledConfig(origin, directory);
    const proxy = createRefractServer(config);
    proxies.push(proxy);
    const addresses = await proxy.start();
    const base = `http://127.0.0.1:${addresses.data.port}`;

    const firstBody = Buffer.from(JSON.stringify({ model: 'gpt-example', input: 'first' }));
    const first = await request(new URL('/v1/responses', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: firstBody });
    expect(first.status).toBe(200);
    const firstId = proxy.lifecycle.snapshot().recent[0]?.id ?? '';
    const firstRow = await eventually(async () => {
      const row = await proxy.durable?.getRequest(firstId);
      return row?.parse_status === 'parsed' ? row : undefined;
    });
    expect(firstRow.provider_response_id).toBe('resp_1');
    const firstDetail = await proxy.durable?.requestDetail(firstId);
    expect(firstDetail?.occurrences).toEqual([
      expect.objectContaining({ phase: 'input', ordinal: 0, provider_type: 'input_text', provider_item_id: null }),
      expect.objectContaining({ phase: 'output', ordinal: 0, provider_type: 'message', provider_item_id: 'msg_1' }),
    ]);

    const secondBody = Buffer.from(JSON.stringify({ model: 'gpt-example', previous_response_id: 'resp_1', input: 'second' }));
    const second = await request(new URL('/v1/responses', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: secondBody });
    expect(second.status).toBe(200);
    const secondId = proxy.lifecycle.snapshot().recent[0]?.id ?? '';
    const secondRow = await eventually(async () => {
      const row = await proxy.durable?.getRequest(secondId);
      return row?.parse_status === 'parsed' ? row : undefined;
    });
    expect(secondRow.parent_request_id).toBe(firstId);
    expect(secondRow.lineage_source).toBe('previous_response_id');
    const transcript = await proxy.durable?.transcript(secondRow.output_tail_id as Buffer);
    expect(transcript).toEqual([
      { schemaVersion: 1, kind: 'message', role: 'user', content: [{ type: 'text', text: 'first' }] },
      { schemaVersion: 1, kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'one' }] },
      { schemaVersion: 1, kind: 'message', role: 'user', content: [{ type: 'text', text: 'second' }] },
      { schemaVersion: 1, kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'two' }] },
    ]);
    const before = await proxy.durable?.counts();
    await replayRetainedRaw({ requestId: secondId, durable: proxy.durable!, raw: proxy.raw!, maximumBodyBytes: config.parserMaxBodyBytes, knownSecrets: [config.credentials.openai.secretValue] });
    await replayRetainedRaw({ requestId: secondId, durable: proxy.durable!, raw: proxy.raw!, maximumBodyBytes: config.parserMaxBodyBytes, knownSecrets: [config.credentials.openai.secretValue] });
    expect(await proxy.durable?.counts()).toEqual(before);
    const replayed = await proxy.durable?.requestDetail(secondId);
    expect(replayed?.output_tail_id).toBe((secondRow.output_tail_id as Buffer).toString('hex'));
    expect(replayed?.occurrences).toEqual([
      expect.objectContaining({ phase: 'input', ordinal: 0, provider_type: 'input_text', provider_item_id: null }),
      expect.objectContaining({ phase: 'output', ordinal: 0, provider_type: 'message', provider_item_id: 'msg_2' }),
    ]);
  });

  test('canonicalizes encoded responses without changing downstream or raw bytes', async () => {
    const body = Buffer.from(JSON.stringify({
      id: 'chat_encoded', object: 'chat.completion', model: 'gpt-example',
      choices: [{ index: 0, message: { role: 'assistant', content: 'encoded answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 2 },
    }));
    const encoders = [
      ['gzip', (value: Buffer) => zlib.gzipSync(value)],
      ['br', (value: Buffer) => zlib.brotliCompressSync(value)],
      ['deflate', (value: Buffer) => zlib.deflateSync(value)],
    ] as const;
    for (const [encoding, encode] of encoders) {
      const wire = encode(body);
      const upstream = http.createServer((_incoming, response) => {
        response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': encoding, 'content-length': String(wire.length) });
        response.end(wire);
      });
      servers.push(upstream);
      const origin = await listen(upstream);
      const directory = temporaryDirectory();
      const config = rawEnabledConfig(origin, directory);
      const proxy = createRefractServer(config);
      proxies.push(proxy);
      const addresses = await proxy.start();
      const requestBody = Buffer.from(JSON.stringify({ model: 'gpt-example', messages: [{ role: 'user', content: 'hello' }] }));
      const result = await request(new URL('/v1/chat/completions', `http://127.0.0.1:${addresses.data.port}`), { method: 'POST', body: requestBody });
      expect(result.body).toEqual(wire);
      const headers = new Map(Array.from({ length: result.rawHeaders.length / 2 }, (_, index) => [result.rawHeaders[index * 2]!.toLowerCase(), result.rawHeaders[index * 2 + 1]!]));
      expect(headers.get('content-encoding')).toBe(encoding);
      const id = proxy.lifecycle.snapshot().recent[0]?.id ?? '';
      const row = await eventually(async () => {
        const current = await proxy.durable?.getRequest(id);
        return current?.parse_status === 'parsed' ? current : undefined;
      });
      expect(await proxy.durable?.transcript(row.output_tail_id as Buffer)).toEqual([
        { schemaVersion: 1, kind: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { schemaVersion: 1, kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'encoded answer' }] },
      ]);
      expect(await proxy.raw?.reconstruct(id, 'response')).toEqual(wire);
      const before = await proxy.durable?.counts();
      await replayRetainedRaw({ requestId: id, durable: proxy.durable!, raw: proxy.raw!, maximumBodyBytes: config.parserMaxBodyBytes, knownSecrets: [config.credentials.openai.secretValue] });
      expect(await proxy.durable?.counts()).toEqual(before);
    }
  });

  test('bounds decoded observer bodies without changing compressed downstream bytes', async () => {
    const body = Buffer.from(JSON.stringify({ id: 'resp_compressed_large', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(512) }] }] }));
    const wire = zlib.gzipSync(body);
    expect(wire.length).toBeLessThan(128);
    const upstream = http.createServer((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(wire.length) });
      response.end(wire);
    });
    servers.push(upstream);
    const origin = await listen(upstream);
    const config = testConfig(origin);
    config.parserMaxBodyBytes = 128;
    const proxy = createRefractServer(config);
    proxies.push(proxy);
    const addresses = await proxy.start();
    const result = await request(new URL('/v1/responses', `http://127.0.0.1:${addresses.data.port}`), { method: 'POST', body: Buffer.from('{"input":"ok"}') });
    expect(result.body).toEqual(wire);
    const id = proxy.lifecycle.snapshot().recent[0]?.id ?? '';
    const row = await eventually(async () => {
      const current = await proxy.durable?.getRequest(id);
      return current?.parse_status === 'failed' ? current : undefined;
    });
    expect(row.parse_error_code).toBe('body_limit');
  });

  test('records and idempotently replays a streaming Chat response', async () => {
    const chunks = [
      { id: 'chat_stream', model: 'gpt-example', choices: [{ index: 0, delta: { role: 'assistant', content: 'streamed ' }, finish_reason: null }] },
      { id: 'chat_stream', model: 'gpt-example', choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }] },
      { id: 'chat_stream', model: 'gpt-example', choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    ];
    const wire = Buffer.from([...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join(''));
    const upstream = http.createServer((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let index = 0; index < wire.length; index += 9) response.write(wire.subarray(index, index + 9));
      response.end();
    });
    servers.push(upstream);
    const origin = await listen(upstream);
    const directory = temporaryDirectory();
    const config = rawEnabledConfig(origin, directory);
    const proxy = createRefractServer(config);
    proxies.push(proxy);
    const addresses = await proxy.start();
    const body = Buffer.from(JSON.stringify({ model: 'gpt-example', stream: true, messages: [{ role: 'user', content: 'hello' }] }));
    const result = await request(new URL('/v1/chat/completions', `http://127.0.0.1:${addresses.data.port}`), { method: 'POST', body });
    expect(result.body).toEqual(wire);
    const id = proxy.lifecycle.snapshot().recent[0]?.id ?? '';
    const row = await eventually(async () => {
      const current = await proxy.durable?.getRequest(id);
      return current?.parse_status === 'parsed' ? current : undefined;
    });
    expect(await proxy.durable?.transcript(row.output_tail_id as Buffer)).toEqual([
      { schemaVersion: 1, kind: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { schemaVersion: 1, kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'streamed answer' }] },
    ]);
    const before = await proxy.durable?.counts();
    await replayRetainedRaw({ requestId: id, durable: proxy.durable!, raw: proxy.raw!, maximumBodyBytes: config.parserMaxBodyBytes, knownSecrets: [config.credentials.openai.secretValue] });
    expect(await proxy.durable?.counts()).toEqual(before);
  });

  test('forwards a leaked provider key but drops raw and redacts durable canonical content', async () => {
    const body = Buffer.from(JSON.stringify({ id: 'resp_secret', object: 'response', model: 'model-openai-test-secret', status: 'completed', usage: { input_tokens: 1, future: 'openai-test-secret' }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'leak openai-test-secret here', annotations: [] }] }] }));
    const upstream = http.createServer((_incoming, response) => { response.setHeader('content-type', 'application/json'); response.end(body); });
    servers.push(upstream);
    const origin = await listen(upstream);
    const directory = temporaryDirectory();
    const config = rawEnabledConfig(origin, directory);
    const proxy = createRefractServer(config);
    proxies.push(proxy);
    const addresses = await proxy.start();
    const result = await request(new URL('/v1/responses', `http://127.0.0.1:${addresses.data.port}`), { method: 'POST', body: Buffer.from('{"input":"hello"}') });
    expect(result.body).toEqual(body);
    const id = proxy.lifecycle.snapshot().recent[0]?.id ?? '';
    const row = await eventually(async () => {
      const current = await proxy.durable?.getRequest(id);
      return current?.parse_status === 'parsed' ? current : undefined;
    });
    expect((await proxy.raw?.getExchange(id))?.capture_state).toBe('dropped_secret');
    expect(JSON.stringify(await proxy.durable?.transcript(row.output_tail_id as Buffer))).toContain('leak [REDACTED] here');
    expect(row.model_resolved).toBe('model-[REDACTED]');
    const physical = Buffer.concat(['durable.db', 'durable.db-wal'].filter((name) => fs.existsSync(path.join(directory, name))).map((name) => fs.readFileSync(path.join(directory, name))));
    expect(physical.includes(Buffer.from('openai-test-secret'))).toBe(false);
  });

  test('records a bounded parse failure without changing oversized response bytes', async () => {
    const body = Buffer.from(JSON.stringify({ id: 'resp_large', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(512) }] }] }));
    const upstream = http.createServer((_incoming, response) => response.end(body));
    servers.push(upstream);
    const origin = await listen(upstream);
    const config = testConfig(origin);
    config.parserMaxBodyBytes = 64;
    const proxy = createRefractServer(config);
    proxies.push(proxy);
    const addresses = await proxy.start();
    const result = await request(new URL('/v1/responses', `http://127.0.0.1:${addresses.data.port}`), { method: 'POST', body: Buffer.from('{"input":"ok"}') });
    expect(result.body).toEqual(body);
    const id = proxy.lifecycle.snapshot().recent[0]?.id ?? '';
    const row = await eventually(async () => {
      const current = await proxy.durable?.getRequest(id);
      return current?.parse_status === 'failed' ? current : undefined;
    });
    expect(row.parse_error_code).toBe('body_limit');
  });

  test('drains canonical observation before shutdown closes durable storage', async () => {
    const responseBody = Buffer.from(JSON.stringify({ id: 'resp_shutdown', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'kept', annotations: [] }] }] }));
    const upstream = http.createServer((_incoming, response) => { response.setHeader('content-type', 'application/json'); response.end(responseBody); });
    servers.push(upstream);
    const origin = await listen(upstream);
    const directory = temporaryDirectory();
    const config = rawEnabledConfig(origin, directory);
    const proxy = createRefractServer(config);
    proxies.push(proxy);
    const addresses = await proxy.start();
    await request(new URL('/v1/responses', `http://127.0.0.1:${addresses.data.port}`), { method: 'POST', body: Buffer.from('{"input":"shutdown"}') });
    const id = proxy.lifecycle.snapshot().recent[0]?.id ?? '';
    proxies.splice(proxies.indexOf(proxy), 1);
    await proxy.close();
    const reopened = await DurableStore.open(config.durablePath);
    expect((await reopened.getRequest(id))?.parse_status).toBe('parsed');
    await reopened.close();
  });

  test('recovers stale active rows during server startup', async () => {
    const upstream = http.createServer((_incoming, response) => response.end('{}'));
    servers.push(upstream);
    const origin = await listen(upstream);
    const directory = temporaryDirectory();
    const durablePath = path.join(directory, 'durable.db');
    const seed = await DurableStore.open(durablePath);
    await seed.acceptRequest({ id: 'stale', startedAtMs: 1, provider: 'openai', surface: 'responses', method: 'POST', pathAndQuery: '/v1/responses', streamingRequested: false });
    await seed.close();
    const config = testConfig(origin);
    config.durablePath = durablePath;
    const proxy = createRefractServer(config);
    proxies.push(proxy);
    const addresses = await proxy.start();
    expect((await proxy.durable?.getRequest('stale'))?.state).toBe('aborted_by_restart');
    const state = await request(new URL('/api/v1/transport', `http://127.0.0.1:${addresses.admin.port}`));
    expect(JSON.parse(state.body.toString())).toMatchObject({ durable: { recoveredRequests: 1 } });
  });

  test('continues forwarding when the durable database cannot open', async () => {
    const upstream = http.createServer((_incoming, response) => response.end('forwarded'));
    servers.push(upstream);
    const origin = await listen(upstream);
    const config = testConfig(origin);
    config.durablePath = temporaryDirectory();
    const proxy = createRefractServer(config);
    proxies.push(proxy);
    const addresses = await proxy.start();
    const result = await request(new URL('/v1/messages', `http://127.0.0.1:${addresses.data.port}`), { method: 'POST', body: Buffer.from('{}') });
    expect(result.body.toString()).toBe('forwarded');
    expect(proxy.durable).toBeNull();
    const state = await request(new URL('/api/v1/transport', `http://127.0.0.1:${addresses.admin.port}`));
    expect(JSON.parse(state.body.toString())).toMatchObject({ durable: { available: false, startupFailed: true } });
  });
});
