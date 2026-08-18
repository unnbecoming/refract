import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compress } from '@mongodb-js/zstd';
import { afterEach, describe, expect, test } from 'vitest';
import type { CanonicalItem } from '../src/canonical/types.js';
import { DurableStore, type CanonicalExchange } from '../src/storage/durable-store.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function filename(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-durable-'));
  directories.push(directory);
  return path.join(directory, 'observability.db');
}

const user: CanonicalItem = { schemaVersion: 1, kind: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] };
const assistant: CanonicalItem = { schemaVersion: 1, kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] };
const branch: CanonicalItem = { schemaVersion: 1, kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'different' }] };

function exchange(id: string, output: CanonicalItem, providerResponseId?: string): CanonicalExchange {
  return {
    request: { id, startedAtMs: 100, provider: 'openai', surface: 'responses', method: 'POST', pathAndQuery: '/v1/responses', streamingRequested: true },
    completedAtMs: 200,
    state: 'completed',
    httpStatus: 200,
    input: [{ item: user, providerType: 'message' }],
    output: [{ item: output, providerType: 'message' }],
    rawCaptureState: 'complete',
    ...(providerResponseId ? { providerResponseId } : {}),
  };
}

describe('durable canonical DAG', () => {
  test('deduplicates repeated full contexts and reconstructs transcripts without raw storage', async () => {
    const store = await DurableStore.open(filename());
    const first = await store.recordCanonicalExchange(exchange('req-1', assistant, 'resp-1'));
    expect(await store.transcript(first.outputTailId)).toEqual([user, assistant]);
    const disposableRaw = path.join(path.dirname(filename()), 'raw.db');
    fs.writeFileSync(disposableRaw, 'disposable');
    fs.rmSync(disposableRaw);
    expect(await store.transcript(first.outputTailId)).toEqual([user, assistant]);
    expect(await store.counts()).toEqual({ items: 2, nodes: 2, requests: 1 });
    const repeated = await store.recordCanonicalExchange(exchange('req-2', assistant));
    expect(repeated).toEqual(first);
    expect(await store.counts()).toEqual({ items: 2, nodes: 2, requests: 2 });
    expect(await store.resolveProviderObject('openai', 'response', 'resp-1')).toEqual({ requestId: 'req-1', outputTailId: first.outputTailId });
    await store.close();
  });

  test('branches immutable suffixes while preserving the prior transcript', async () => {
    const store = await DurableStore.open(filename());
    const first = await store.recordCanonicalExchange(exchange('req-1', assistant));
    const changed = await store.recordCanonicalExchange(exchange('req-2', branch));
    expect(changed.inputTailId).toEqual(first.inputTailId);
    expect(changed.outputTailId).not.toEqual(first.outputTailId);
    expect(await store.transcript(first.outputTailId)).toEqual([user, assistant]);
    expect(await store.transcript(changed.outputTailId)).toEqual([user, branch]);
    expect(await store.counts()).toEqual({ items: 3, nodes: 3, requests: 2 });
    await store.close();
  });

  test('uses an explicit prior tail as ancestry for visible new input', async () => {
    const store = await DurableStore.open(filename());
    const first = await store.recordCanonicalExchange(exchange('req-1', assistant, 'resp-1'));
    const continuation: CanonicalExchange = {
      ...exchange('req-2', branch),
      baseTailId: first.outputTailId,
      input: [{ item: { schemaVersion: 1, kind: 'message', role: 'user', content: [{ type: 'text', text: 'continue' }] } }],
      previousResponseId: 'resp-1',
      parentRequestId: 'req-1',
      lineageSource: 'provider_reference',
    };
    const result = await store.recordCanonicalExchange(continuation);
    expect(await store.transcript(result.outputTailId)).toEqual([
      user, assistant, continuation.input[0]?.item, branch,
    ]);
    await store.close();
  });

  test('detects item payload corruption as a hash collision and rolls back the request', async () => {
    const file = filename();
    const store = await DurableStore.open(file);
    await store.recordCanonicalExchange(exchange('req-1', assistant));
    await store.close();

    const sqlite = await import('sqlite');
    const sqlite3 = (await import('sqlite3')).default;
    const db = await sqlite.open({ filename: file, driver: sqlite3.Database });
    const item = await db.get<{ id: Buffer }>('SELECT id FROM items ORDER BY created_at_ms LIMIT 1');
    const corrupt = await compress(Buffer.from('{"corrupt":true}'));
    await db.run('UPDATE items SET payload = ? WHERE id = ?', corrupt, item?.id);
    await db.close();

    const reopened = await DurableStore.open(file);
    await expect(reopened.recordCanonicalExchange(exchange('req-2', assistant))).rejects.toThrow(/hash collision/);
    expect(await reopened.counts()).toEqual({ items: 2, nodes: 2, requests: 1 });
    await reopened.close();
  });

  test('scrubs known credentials recursively before durable hashing and storage', async () => {
    const store = await DurableStore.open(filename());
    const secret = Buffer.from('provider-secret-value');
    const unknown: CanonicalItem = {
      schemaVersion: 1,
      kind: 'unknown',
      provider: 'openai',
      providerType: 'future_item',
      payload: { nested: ['safe', 'prefix provider-secret-value suffix'] },
    };
    const input = exchange('secret-request', assistant);
    input.input = [{ item: unknown }];
    input.knownSecrets = [secret];
    const result = await store.recordCanonicalExchange(input);
    const transcript = await store.transcript(result.outputTailId);
    expect(JSON.stringify(transcript)).not.toContain('provider-secret-value');
    expect(JSON.stringify(transcript)).toContain('prefix [REDACTED] suffix');
    await store.close();
  });

  test('marks stale active requests aborted on restart and rejects unknown schema markers', async () => {
    const file = filename();
    const store = await DurableStore.open(file);
    await store.acceptRequest({ id: 'active', startedAtMs: 1, provider: 'anthropic', surface: 'messages', method: 'POST', pathAndQuery: '/v1/messages', streamingRequested: false });
    expect(await store.recoverActive(50)).toBe(1);
    expect(await store.recoverActive(60)).toBe(0);
    await store.close();
    const bytes = fs.readFileSync(file);
    expect(bytes.length).toBeGreaterThan(0);

    const bad = filename();
    const sqlite = await import('sqlite');
    const sqlite3 = (await import('sqlite3')).default;
    const db = await sqlite.open({ filename: bad, driver: sqlite3.Database });
    await db.exec('CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await db.run('INSERT INTO schema_metadata VALUES (?, ?)', 'schema_version', '999');
    await db.close();
    await expect(DurableStore.open(bad)).rejects.toThrow(/unsupported durable schema marker 999/);
  });
});
