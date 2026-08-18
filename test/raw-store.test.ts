import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { RawCaptureStore, type RawStoreConfig } from '../src/storage/raw-store.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function fixture(overrides: Partial<RawStoreConfig> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-raw-'));
  directories.push(directory);
  const config: RawStoreConfig = {
    path: path.join(directory, 'raw.db'), retentionHours: 168, deleteBatchSize: 10,
    maxDbBytes: 64 * 1024 * 1024, targetDbBytes: 48 * 1024 * 1024,
    maxExchangeBytes: 1024 * 1024, blockBytes: 7, maxQueuedWrites: 100,
    ...overrides,
  };
  return { directory, config, store: new RawCaptureStore(config) };
}

describe('raw capture store', () => {
  test('reconstructs ordered exact bytes and records completion in a separate database', async () => {
    const { store, config } = fixture();
    const capture = store.begin({ requestId: 'req-1', provider: 'openai', requestHeaders: [['Authorization', '[REDACTED]']], knownSecrets: [Buffer.from('never-store-this')] });
    capture.observe('request', Buffer.from('request-'));
    capture.observe('request', Buffer.from('bytes'));
    capture.complete('request');
    capture.responseStarted(200, [['Set-Cookie', '[REDACTED]']]);
    capture.observe('response', Buffer.from('response-bytes'));
    capture.complete('response');
    await store.flush();
    expect(await store.reconstruct('req-1', 'request')).toEqual(Buffer.from('request-bytes'));
    expect(await store.reconstruct('req-1', 'response')).toEqual(Buffer.from('response-bytes'));
    const row = await store.getExchange('req-1');
    expect(row).toMatchObject({ capture_state: 'complete', request_complete: 1, response_complete: 1, request_bytes: 13, response_bytes: 14 });
    expect(row?.request_sha256).toEqual(crypto.createHash('sha256').update('request-bytes').digest());
    expect(row?.response_sha256).toEqual(crypto.createHash('sha256').update('response-bytes').digest());
    expect(fs.existsSync(config.path)).toBe(true);
    await store.close();
  });

  test('drops all chunks when a known secret crosses an observation boundary', async () => {
    const { store, config } = fixture();
    const secret = 'provider-secret-value';
    const capture = store.begin({ requestId: 'req-secret', provider: 'anthropic', requestHeaders: [], knownSecrets: [Buffer.from(secret)] });
    capture.observe('request', Buffer.from('safe-prefix-provider-sec'));
    capture.observe('request', Buffer.from('ret-value-safe-suffix'));
    capture.complete('request');
    await store.flush();
    expect(await store.getExchange('req-secret')).toMatchObject({ capture_state: 'dropped_secret' });
    expect(await store.reconstruct('req-secret', 'request')).toEqual(Buffer.alloc(0));
    const physical = Buffer.concat([fs.readFileSync(config.path), fs.existsSync(`${config.path}-wal`) ? fs.readFileSync(`${config.path}-wal`) : Buffer.alloc(0)]);
    expect(physical.includes(Buffer.from(secret))).toBe(false);
    await store.close();
  });

  test('marks oversize and queued-write pressure drops without retaining chunks', async () => {
    const oversizeFixture = fixture({ maxExchangeBytes: 4 });
    const oversize = oversizeFixture.store.begin({ requestId: 'oversize', provider: 'openai', requestHeaders: [], knownSecrets: [] });
    oversize.observe('request', Buffer.from('five!'));
    await oversizeFixture.store.flush();
    expect(await oversizeFixture.store.getExchange('oversize')).toMatchObject({ capture_state: 'dropped_oversize' });
    expect(oversizeFixture.store.stats().drops.dropped_oversize).toBe(1);
    await oversizeFixture.store.close();

    const pressureFixture = fixture({ blockBytes: 1, maxQueuedWrites: 1 });
    const pressure = pressureFixture.store.begin({ requestId: 'pressure', provider: 'openai', requestHeaders: [], knownSecrets: [] });
    await pressureFixture.store.flush();
    pressure.observe('request', Buffer.from('ab'));
    await pressureFixture.store.flush();
    expect(await pressureFixture.store.getExchange('pressure')).toMatchObject({ capture_state: 'dropped_pressure' });
    expect(await pressureFixture.store.reconstruct('pressure', 'request')).toEqual(Buffer.alloc(0));
    expect(pressureFixture.store.stats().drops.dropped_pressure).toBe(1);
    await pressureFixture.store.close();
  });

  test('applies current created-at retention without per-row expiry', async () => {
    const { store } = fixture({ retentionHours: 3 });
    const old = store.begin({ requestId: 'old', provider: 'openai', requestHeaders: [], knownSecrets: [], createdAtMs: 1_000 });
    old.complete('request'); old.complete('response');
    const recent = store.begin({ requestId: 'recent', provider: 'openai', requestHeaders: [], knownSecrets: [], createdAtMs: 20_000_000 });
    recent.complete('request'); recent.complete('response');
    await store.flush();
    const result = await store.prune(20_000_000);
    expect(result.ageDeleted).toBe(1);
    expect(await store.getExchange('old')).toBeUndefined();
    expect(await store.getExchange('recent')).toBeDefined();
    await store.close();
  });

  test('emergency pruning removes oldest exchanges when used pages exceed the hard cap', async () => {
    const { store } = fixture({ maxDbBytes: 1, targetDbBytes: 0, deleteBatchSize: 1 });
    for (const [index, id] of ['first', 'second'].entries()) {
      const capture = store.begin({ requestId: id, provider: 'openai', requestHeaders: [], knownSecrets: [], createdAtMs: index + 1 });
      capture.observe('request', Buffer.alloc(128, index));
      capture.complete('request');
      capture.complete('response');
    }
    await store.flush();
    const result = await store.prune(10);
    expect(result.emergencyDeleted).toBeGreaterThan(0);
    expect(await store.getExchange('first')).toBeUndefined();
    await store.close();
  });
});
