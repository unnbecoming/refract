import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compress, decompress } from '@mongodb-js/zstd';
import { open, type Database } from 'sqlite';
import sqlite3 from 'sqlite3';
import type { Provider } from '../config.js';
import type { HeaderPair } from '../proxy/headers.js';

export type RawCaptureState = 'recording' | 'complete' | 'partial' | 'dropped_secret' | 'dropped_oversize' | 'dropped_pressure' | 'dropped_storage';
export type RawDirection = 'request' | 'response';

export interface RawStoreConfig {
  path: string;
  retentionHours: number;
  deleteBatchSize: number;
  maxDbBytes: number;
  targetDbBytes: number;
  maxExchangeBytes: number;
  blockBytes: number;
  maxQueuedWrites: number;
}

export interface RawExchangeInput {
  requestId: string;
  provider: Provider;
  requestHeaders: HeaderPair[];
  knownSecrets: Buffer[];
  createdAtMs?: number;
}

interface DirectionState {
  hash: crypto.Hash;
  bytes: number;
  sequence: number;
  buffer: Buffer;
  complete: boolean;
  tail: Buffer;
}

export interface RawExchangeRow {
  request_id: string;
  created_at_ms: number;
  provider: Provider;
  capture_state: RawCaptureState;
  capture_error: string | null;
  request_complete: number;
  response_complete: number;
  request_bytes: number;
  response_bytes: number;
  response_status: number | null;
  request_sha256: Buffer | null;
  response_sha256: Buffer | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS raw_schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS raw_exchanges (
  request_id TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  provider TEXT NOT NULL,
  request_headers_zstd BLOB,
  response_headers_zstd BLOB,
  response_status INTEGER,
  request_complete INTEGER NOT NULL DEFAULT 0,
  response_complete INTEGER NOT NULL DEFAULT 0,
  request_bytes INTEGER NOT NULL DEFAULT 0,
  response_bytes INTEGER NOT NULL DEFAULT 0,
  request_sha256 BLOB,
  response_sha256 BLOB,
  capture_state TEXT NOT NULL,
  capture_error TEXT
);
CREATE INDEX IF NOT EXISTS raw_exchanges_created_idx ON raw_exchanges(created_at_ms, request_id);
CREATE TABLE IF NOT EXISTS raw_body_chunks (
  request_id TEXT NOT NULL REFERENCES raw_exchanges(request_id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('request', 'response')),
  sequence INTEGER NOT NULL,
  codec TEXT NOT NULL CHECK (codec = 'zstd'),
  uncompressed_bytes INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (request_id, direction, sequence)
);
`;

function encodeHeaders(headers: readonly HeaderPair[]): Buffer {
  return Buffer.from(JSON.stringify(headers));
}

export class RawCaptureStore {
  readonly #db: Promise<Database>;
  readonly #config: RawStoreConfig;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  #writeFailures = 0;
  #agePruned = 0;
  #emergencyPruned = 0;
  #lastPrune: { atMs: number; durationMs: number; ageDeleted: number; emergencyDeleted: number } | null = null;
  readonly #drops: Partial<Record<RawCaptureState, number>> = {};

  constructor(config: RawStoreConfig) {
    this.#config = config;
    fs.mkdirSync(path.dirname(config.path), { recursive: true });
    const fresh = !fs.existsSync(config.path);
    this.#db = this.#open(config.path, fresh);
    void this.#db.catch(() => undefined);
  }

  async #open(filename: string, fresh: boolean): Promise<Database> {
    const db = await open({ filename, driver: sqlite3.Database });
    if (fresh) await db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    await db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250; PRAGMA synchronous = NORMAL; PRAGMA secure_delete = ON; ${SCHEMA}`);
    const marker = await db.get<{ value: string }>('SELECT value FROM raw_schema_metadata WHERE key = ?', 'schema_version');
    if (marker && marker.value !== '1') throw new Error(`unsupported raw schema version ${marker.value}`);
    await db.run('INSERT OR IGNORE INTO raw_schema_metadata (key, value) VALUES (?, ?)', 'schema_version', '1');
    return db;
  }

  async ready(): Promise<void> {
    await this.#db;
  }

  begin(input: RawExchangeInput): RawExchangeCapture {
    const capture = new RawExchangeCapture(this, input, this.#config);
    const accepted = this.enqueue(async () => {
      const headers = await compress(encodeHeaders(input.requestHeaders));
      const db = await this.#db;
      await db.run(`INSERT INTO raw_exchanges
        (request_id, created_at_ms, provider, request_headers_zstd, capture_state)
        VALUES (?, ?, ?, ?, 'recording')`, input.requestId, input.createdAtMs ?? Date.now(), input.provider, headers);
    });
    if (!accepted) capture.drop('dropped_pressure');
    return capture;
  }

  enqueue(task: () => Promise<void> | void, priority = false): boolean {
    if (!priority && this.#pending >= this.#config.maxQueuedWrites) return false;
    this.#pending += 1;
    this.#tail = this.#tail.then(task).catch(() => { this.#writeFailures += 1; }).finally(() => { this.#pending -= 1; });
    return true;
  }

  insertChunk(requestId: string, direction: RawDirection, sequence: number, bytes: Buffer): boolean {
    return this.enqueue(async () => {
      const encoded = await compress(bytes);
      const db = await this.#db;
      await db.run(`INSERT INTO raw_body_chunks
        (request_id, direction, sequence, codec, uncompressed_bytes, data)
        VALUES (?, ?, ?, 'zstd', ?, ?)`, requestId, direction, sequence, bytes.length, encoded);
    });
  }

  updateExchange(requestId: string, fields: Record<string, unknown>): boolean {
    const allowed = new Set(['response_headers_zstd', 'response_status', 'request_complete', 'response_complete', 'request_bytes', 'response_bytes', 'request_sha256', 'response_sha256', 'capture_state', 'capture_error']);
    const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
    if (entries.length === 0) return true;
    return this.enqueue(async () => {
      const values: unknown[] = [];
      const sets: string[] = [];
      for (const [key, raw] of entries) {
        const value = key === 'response_headers_zstd' && Buffer.isBuffer(raw) ? await compress(raw) : raw;
        sets.push(`${key} = ?`);
        values.push(value);
      }
      const db = await this.#db;
      await db.run(`UPDATE raw_exchanges SET ${sets.join(', ')} WHERE request_id = ?`, ...values, requestId);
    });
  }

  dropExchange(requestId: string, state: RawCaptureState): void {
    this.#drops[state] = (this.#drops[state] ?? 0) + 1;
    this.enqueue(async () => {
      const db = await this.#db;
      await db.run('DELETE FROM raw_body_chunks WHERE request_id = ?', requestId);
      await db.run('UPDATE raw_exchanges SET capture_state = ?, capture_error = ? WHERE request_id = ?', state, state, requestId);
    }, true);
  }

  async flush(): Promise<void> {
    await this.#tail;
  }

  async reconstruct(requestId: string, direction: RawDirection): Promise<Buffer> {
    await this.flush();
    const db = await this.#db;
    const rows = await db.all<Array<{ data: Buffer }>>(`SELECT data FROM raw_body_chunks
      WHERE request_id = ? AND direction = ? ORDER BY sequence`, requestId, direction);
    const blocks: Buffer[] = [];
    for (const row of rows) blocks.push(Buffer.from(await decompress(row.data)));
    return Buffer.concat(blocks);
  }

  async getExchange(requestId: string): Promise<RawExchangeRow | undefined> {
    await this.flush();
    const db = await this.#db;
    return db.get<RawExchangeRow>(`SELECT request_id, created_at_ms, provider, capture_state, capture_error,
      request_complete, response_complete, request_bytes, response_bytes, response_status,
      request_sha256, response_sha256 FROM raw_exchanges WHERE request_id = ?`, requestId);
  }

  async manifest(requestId: string): Promise<(RawExchangeRow & { requestHeaders: HeaderPair[]; responseHeaders: HeaderPair[] }) | undefined> {
    await this.flush();
    const db = await this.#db;
    const row = await db.get<RawExchangeRow & { request_headers_zstd: Buffer | null; response_headers_zstd: Buffer | null }>(`SELECT
      request_id, created_at_ms, provider, capture_state, capture_error, request_complete, response_complete,
      request_bytes, response_bytes, response_status, request_sha256, response_sha256,
      request_headers_zstd, response_headers_zstd FROM raw_exchanges WHERE request_id = ?`, requestId);
    if (!row) return undefined;
    const decode = async (value: Buffer | null): Promise<HeaderPair[]> => value
      ? JSON.parse(Buffer.from(await decompress(value)).toString('utf8')) as HeaderPair[]
      : [];
    const { request_headers_zstd, response_headers_zstd, ...metadata } = row;
    return { ...metadata, requestHeaders: await decode(request_headers_zstd), responseHeaders: await decode(response_headers_zstd) };
  }

  async retainedStates(requestIds: readonly string[]): Promise<Map<string, RawCaptureState>> {
    if (requestIds.length === 0) return new Map();
    if (requestIds.length > 100) throw new Error('too_many_request_ids');
    await this.flush();
    const db = await this.#db;
    const rows = await db.all<Array<{ request_id: string; capture_state: RawCaptureState }>>(
      `SELECT request_id, capture_state FROM raw_exchanges WHERE request_id IN (${requestIds.map(() => '?').join(',')})`,
      ...requestIds,
    );
    return new Map(rows.map((row) => [row.request_id, row.capture_state]));
  }

  async retentionStatus(): Promise<Record<string, unknown>> {
    await this.flush();
    const db = await this.#db;
    const range = await db.get<{ oldest: number | null; newest: number | null; retained: number }>(`SELECT
      min(created_at_ms) AS oldest, max(created_at_ms) AS newest, count(*) AS retained FROM raw_exchanges`);
    const pageSize = await db.get<{ page_size: number }>('PRAGMA page_size');
    const pages = await db.get<{ page_count: number }>('PRAGMA page_count');
    const free = await db.get<{ freelist_count: number }>('PRAGMA freelist_count');
    return {
      retentionHours: this.#config.retentionHours,
      oldestRetainedAtMs: range?.oldest ?? null,
      newestRetainedAtMs: range?.newest ?? null,
      retained: range?.retained ?? 0,
      usedBytes: ((pages?.page_count ?? 0) - (free?.freelist_count ?? 0)) * (pageSize?.page_size ?? 0),
      lastPrune: this.#lastPrune,
    };
  }

  async prune(nowMs = Date.now()): Promise<{ ageDeleted: number; emergencyDeleted: number }> {
    const startedAt = Date.now();
    await this.flush();
    let ageDeleted = 0;
    let emergencyDeleted = 0;
    const cutoff = nowMs - this.#config.retentionHours * 3_600_000;
    const db = await this.#db;
    const removeSql = `DELETE FROM raw_exchanges WHERE request_id IN (
      SELECT request_id FROM raw_exchanges WHERE created_at_ms < ? ORDER BY created_at_ms, request_id LIMIT ?)`;
    while (true) {
      const count = (await db.run(removeSql, cutoff, this.#config.deleteBatchSize)).changes ?? 0;
      ageDeleted += count;
      if (count < this.#config.deleteBatchSize) break;
    }
    const usedBytes = async () => {
      const pageSize = await db.get<{ page_size: number }>('PRAGMA page_size');
      const pages = await db.get<{ page_count: number }>('PRAGMA page_count');
      const free = await db.get<{ freelist_count: number }>('PRAGMA freelist_count');
      return ((pages?.page_count ?? 0) - (free?.freelist_count ?? 0)) * (pageSize?.page_size ?? 0);
    };
    while (await usedBytes() > this.#config.maxDbBytes) {
      const result = await db.run(`DELETE FROM raw_exchanges WHERE request_id IN (
        SELECT request_id FROM raw_exchanges ORDER BY created_at_ms, request_id LIMIT ?)`, this.#config.deleteBatchSize);
      const count = result.changes ?? 0;
      emergencyDeleted += count;
      if (count === 0 || await usedBytes() <= this.#config.targetDbBytes) break;
    }
    await db.exec('PRAGMA incremental_vacuum(64)');
    this.#agePruned += ageDeleted;
    this.#emergencyPruned += emergencyDeleted;
    this.#lastPrune = { atMs: Date.now(), durationMs: Date.now() - startedAt, ageDeleted, emergencyDeleted };
    return { ageDeleted, emergencyDeleted };
  }

  stats(): { pendingWrites: number; writeFailures: number; agePruned: number; emergencyPruned: number; drops: Partial<Record<RawCaptureState, number>> } {
    return { pendingWrites: this.#pending, writeFailures: this.#writeFailures, agePruned: this.#agePruned, emergencyPruned: this.#emergencyPruned, drops: { ...this.#drops } };
  }

  async close(): Promise<void> {
    await this.flush();
    const db = await this.#db;
    await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    await db.close();
  }
}

export class RawExchangeCapture {
  readonly #store: RawCaptureStore;
  readonly #requestId: string;
  readonly #config: RawStoreConfig;
  readonly #secrets: Buffer[];
  readonly #directions: Record<RawDirection, DirectionState>;
  #state: RawCaptureState = 'recording';

  constructor(store: RawCaptureStore, input: RawExchangeInput, config: RawStoreConfig) {
    this.#store = store;
    this.#requestId = input.requestId;
    this.#config = config;
    this.#secrets = input.knownSecrets.filter((secret) => secret.length >= 4).map((secret) => Buffer.from(secret));
    const make = (): DirectionState => ({ hash: crypto.createHash('sha256'), bytes: 0, sequence: 0, buffer: Buffer.alloc(0), complete: false, tail: Buffer.alloc(0) });
    this.#directions = { request: make(), response: make() };
  }

  responseStarted(status: number, headers: HeaderPair[]): void {
    this.#store.updateExchange(this.#requestId, { response_status: status, response_headers_zstd: encodeHeaders(headers) });
  }

  observe(direction: RawDirection, chunk: Buffer): void {
    if (this.#state !== 'recording') return;
    const state = this.#directions[direction];
    state.bytes += chunk.length;
    if (this.#directions.request.bytes + this.#directions.response.bytes > this.#config.maxExchangeBytes) {
      this.drop('dropped_oversize');
      return;
    }
    const scan = Buffer.concat([state.tail, chunk]);
    if (this.#secrets.some((secret) => scan.indexOf(secret) !== -1)) {
      this.drop('dropped_secret');
      return;
    }
    const longest = this.#secrets.reduce((max, secret) => Math.max(max, secret.length), 1);
    state.tail = scan.subarray(Math.max(0, scan.length - longest + 1));
    state.hash.update(chunk);
    state.buffer = Buffer.concat([state.buffer, chunk]);
    while (state.buffer.length >= this.#config.blockBytes) {
      const block = state.buffer.subarray(0, this.#config.blockBytes);
      state.buffer = state.buffer.subarray(this.#config.blockBytes);
      if (!this.#store.insertChunk(this.#requestId, direction, state.sequence++, block)) {
        this.drop('dropped_pressure');
        return;
      }
    }
  }

  complete(direction: RawDirection): void {
    if (this.#state !== 'recording') return;
    const state = this.#directions[direction];
    if (state.complete) return;
    if (state.buffer.length > 0 && !this.#store.insertChunk(this.#requestId, direction, state.sequence++, state.buffer)) {
      this.drop('dropped_pressure');
      return;
    }
    state.buffer = Buffer.alloc(0);
    state.complete = true;
    this.#store.updateExchange(this.#requestId, {
      [`${direction}_complete`]: 1,
      [`${direction}_bytes`]: state.bytes,
      [`${direction}_sha256`]: state.hash.digest(),
      capture_state: this.#directions.request.complete && this.#directions.response.complete ? 'complete' : 'recording',
    });
    if (this.#directions.request.complete && this.#directions.response.complete) this.#state = 'complete';
  }

  partial(): void {
    if (this.#state !== 'recording') return;
    this.#state = 'partial';
    this.#store.updateExchange(this.#requestId, { capture_state: 'partial' });
  }

  drop(state: Exclude<RawCaptureState, 'recording' | 'complete' | 'partial'>): void {
    if (this.#state !== 'recording') return;
    this.#state = state;
    this.#directions.request.buffer = Buffer.alloc(0);
    this.#directions.response.buffer = Buffer.alloc(0);
    this.#store.dropExchange(this.#requestId, state);
  }
}
