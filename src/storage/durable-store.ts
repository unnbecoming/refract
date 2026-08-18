import * as fs from 'node:fs';
import * as path from 'node:path';
import { compress, decompress } from '@mongodb-js/zstd';
import { open, type Database } from 'sqlite';
import sqlite3 from 'sqlite3';
import type { ApiSurface, Provider } from '../config.js';
import { itemBytes, itemId, nodeId } from '../canonical/hashing.js';
import type { CanonicalItem } from '../canonical/types.js';
import { scrubKnownSecrets } from '../credentials/redact.js';
import { DURABLE_SCHEMA, DURABLE_SCHEMA_VERSION } from './durable-schema.js';

export interface RequestMetadata {
  id: string;
  startedAtMs: number;
  provider: Provider;
  surface: ApiSurface;
  method: string;
  pathAndQuery: string;
  streamingRequested: boolean;
}

export interface CanonicalOccurrence {
  item: CanonicalItem;
  providerType?: string;
  providerItemId?: string;
  providerMetadata?: unknown;
}

export interface CanonicalUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  raw?: unknown;
}

export interface CanonicalExchange {
  request: RequestMetadata;
  completedAtMs: number;
  state: string;
  httpStatus?: number;
  modelRequested?: string;
  modelResolved?: string;
  ttfbMs?: number;
  totalMs?: number;
  requestBytes?: number;
  responseBytes?: number;
  usage?: CanonicalUsage;
  baseTailId?: Buffer | null;
  input: CanonicalOccurrence[];
  output: CanonicalOccurrence[];
  parentRequestId?: string;
  lineageSource?: string;
  providerResponseId?: string;
  previousResponseId?: string;
  providerConversationId?: string;
  rawCaptureState: string;
  knownSecrets?: Buffer[];
}

export interface FoldResult {
  tailId: Buffer | null;
  nodeIds: Buffer[];
}

interface NodeRow { id: Buffer; parent_id: Buffer | null; item_id: Buffer; depth: number }
interface ItemRow { payload: Buffer }

export class DurableStore {
  readonly #db: Database;
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(db: Database) { this.#db = db; }

  static async open(filename: string): Promise<DurableStore> {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const fresh = !fs.existsSync(filename);
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
    if (fresh) {
      await db.exec(DURABLE_SCHEMA);
      await db.run('INSERT INTO schema_metadata (key, value) VALUES (?, ?)', 'schema_version', DURABLE_SCHEMA_VERSION);
    } else {
      const marker = await db.get<{ value: string }>('SELECT value FROM schema_metadata WHERE key = ?', 'schema_version').catch(() => undefined);
      if (!marker || marker.value !== DURABLE_SCHEMA_VERSION) {
        await db.close();
        throw new Error(`unsupported durable schema marker ${marker?.value ?? 'missing'}`);
      }
    }
    return new DurableStore(db);
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(operation, operation);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #transaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.#serialized(async () => {
      await this.#db.exec('BEGIN IMMEDIATE');
      try {
        const result = await operation();
        await this.#db.exec('COMMIT');
        return result;
      } catch (error) {
        await this.#db.exec('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  async acceptRequest(request: RequestMetadata): Promise<void> {
    await this.#serialized(async () => {
      await this.#db.run(`INSERT INTO requests
        (id, started_at_ms, provider, api_surface, method, path_and_query, state, streaming_requested)
        VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?)`,
      request.id, request.startedAtMs, request.provider, request.surface, request.method,
      request.pathAndQuery, request.streamingRequested ? 1 : 0);
    });
  }

  async recoverActive(nowMs = Date.now()): Promise<number> {
    return this.#serialized(async () => {
      const result = await this.#db.run(`UPDATE requests SET state = 'aborted_by_restart', completed_at_ms = ?
        WHERE state IN ('accepted', 'upstream_started', 'response_started')`, nowMs);
      return result.changes ?? 0;
    });
  }

  async #storeItem(item: CanonicalItem, nowMs: number): Promise<Buffer> {
    const id = itemId(item);
    const bytes = itemBytes(item);
    const existing = await this.#db.get<ItemRow>('SELECT payload FROM items WHERE id = ?', id);
    if (existing) {
      const stored = Buffer.from(await decompress(existing.payload));
      if (!stored.equals(bytes)) throw new Error(`canonical item hash collision for ${id.toString('hex')}`);
      return id;
    }
    const payload = await compress(bytes);
    await this.#db.run(`INSERT INTO items
      (id, schema_version, kind, payload_codec, payload, canonical_bytes, created_at_ms)
      VALUES (?, ?, ?, 'zstd', ?, ?, ?)`, id, item.schemaVersion, item.kind, payload, bytes.length, nowMs);
    return id;
  }

  async #fold(baseTailId: Buffer | null, occurrences: readonly CanonicalOccurrence[], nowMs: number, knownSecrets: readonly Buffer[]): Promise<FoldResult> {
    let parent = baseTailId;
    let depth = 0;
    if (parent) {
      const row = await this.#db.get<{ depth: number }>('SELECT depth FROM context_nodes WHERE id = ?', parent);
      if (!row) throw new Error('base context tail is unknown');
      depth = row.depth;
    }
    const nodeIds: Buffer[] = [];
    for (const occurrence of occurrences) {
      const canonicalItem = scrubKnownSecrets(occurrence.item, knownSecrets);
      const canonicalItemId = await this.#storeItem(canonicalItem, nowMs);
      const id = nodeId(parent, canonicalItemId);
      const existing = await this.#db.get<NodeRow>('SELECT id, parent_id, item_id, depth FROM context_nodes WHERE id = ?', id);
      depth += 1;
      if (existing) {
        const sameParent = parent === null ? existing.parent_id === null : existing.parent_id?.equals(parent) === true;
        if (!sameParent || !existing.item_id.equals(canonicalItemId) || existing.depth !== depth) {
          throw new Error(`context node hash collision for ${id.toString('hex')}`);
        }
      } else {
        await this.#db.run(`INSERT INTO context_nodes (id, parent_id, item_id, depth, created_at_ms)
          VALUES (?, ?, ?, ?, ?)`, id, parent, canonicalItemId, depth, nowMs);
      }
      nodeIds.push(id);
      parent = id;
    }
    return { tailId: parent, nodeIds };
  }

  async recordCanonicalExchange(exchange: CanonicalExchange): Promise<{ inputTailId: Buffer | null; outputTailId: Buffer | null }> {
    return this.#transaction(async () => {
      const knownSecrets = exchange.knownSecrets ?? [];
      const input = await this.#fold(exchange.baseTailId ?? null, exchange.input, exchange.completedAtMs, knownSecrets);
      const output = await this.#fold(input.tailId, exchange.output, exchange.completedAtMs, knownSecrets);
      await this.#db.run(`INSERT OR IGNORE INTO requests
        (id, started_at_ms, provider, api_surface, method, path_and_query, state, streaming_requested)
        VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?)`, exchange.request.id, exchange.request.startedAtMs,
      exchange.request.provider, exchange.request.surface, exchange.request.method, exchange.request.pathAndQuery,
      exchange.request.streamingRequested ? 1 : 0);
      const scrub = <T>(value: T): T => scrubKnownSecrets(value, knownSecrets);
      const usageJson = exchange.usage?.raw === undefined ? null : await compress(Buffer.from(JSON.stringify(scrub(exchange.usage.raw))));
      await this.#db.run(`UPDATE requests SET completed_at_ms = ?, state = ?, http_status = ?,
        streaming_requested = ?, model_requested = ?, model_resolved = ?, input_tail_id = ?, output_tail_id = ?,
        parent_request_id = ?, lineage_source = ?, provider_response_id = ?, previous_response_id = ?,
        provider_conversation_id = ?, ttfb_ms = ?, total_ms = ?, request_bytes = ?, response_bytes = ?,
        input_tokens = ?, output_tokens = ?, cached_input_tokens = ?, cache_write_tokens = ?, reasoning_tokens = ?,
        usage_json_zstd = ?, parse_status = 'parsed', parse_error_code = NULL, parse_error_message = NULL,
        raw_capture_state = ? WHERE id = ?`,
      exchange.completedAtMs, exchange.state, exchange.httpStatus ?? null, exchange.request.streamingRequested ? 1 : 0,
      exchange.modelRequested === undefined ? null : scrub(exchange.modelRequested),
      exchange.modelResolved === undefined ? null : scrub(exchange.modelResolved), input.tailId, output.tailId,
      exchange.parentRequestId ?? null, exchange.lineageSource ?? null,
      exchange.providerResponseId === undefined ? null : scrub(exchange.providerResponseId),
      exchange.previousResponseId === undefined ? null : scrub(exchange.previousResponseId),
      exchange.providerConversationId === undefined ? null : scrub(exchange.providerConversationId),
      exchange.ttfbMs ?? null, exchange.totalMs ?? null, exchange.requestBytes ?? 0, exchange.responseBytes ?? 0,
      exchange.usage?.inputTokens ?? null, exchange.usage?.outputTokens ?? null,
      exchange.usage?.cachedInputTokens ?? null, exchange.usage?.cacheWriteTokens ?? null,
      exchange.usage?.reasoningTokens ?? null, usageJson, exchange.rawCaptureState, exchange.request.id);
      await this.#db.run('DELETE FROM request_item_occurrences WHERE request_id = ?', exchange.request.id);
      const insertOccurrence = async (phase: 'input' | 'output', values: readonly CanonicalOccurrence[], nodes: readonly Buffer[]) => {
        for (const [ordinal, occurrence] of values.entries()) {
          const metadata = occurrence.providerMetadata === undefined ? null : await compress(Buffer.from(JSON.stringify(scrub(occurrence.providerMetadata))));
          await this.#db.run(`INSERT INTO request_item_occurrences
            (request_id, phase, ordinal, node_id, provider_type, provider_item_id, provider_metadata_zstd)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, exchange.request.id, phase, ordinal, nodes[ordinal],
          occurrence.providerType ?? null, occurrence.providerItemId ?? null, metadata);
        }
      };
      await insertOccurrence('input', exchange.input, input.nodeIds);
      await insertOccurrence('output', exchange.output, output.nodeIds);
      if (exchange.providerResponseId) {
        await this.#db.run(`INSERT INTO provider_objects
          (provider, object_type, object_id, request_id, output_tail_id) VALUES (?, 'response', ?, ?, ?)
          ON CONFLICT(provider, object_type, object_id) DO UPDATE SET request_id = excluded.request_id, output_tail_id = excluded.output_tail_id`,
        exchange.request.provider, scrub(exchange.providerResponseId), exchange.request.id, output.tailId);
      }
      if (exchange.providerConversationId) {
        await this.#db.run(`INSERT INTO provider_objects
          (provider, object_type, object_id, request_id, output_tail_id) VALUES (?, 'conversation', ?, ?, ?)
          ON CONFLICT(provider, object_type, object_id) DO UPDATE SET request_id = excluded.request_id, output_tail_id = excluded.output_tail_id`,
        exchange.request.provider, scrub(exchange.providerConversationId), exchange.request.id, output.tailId);
      }
      return { inputTailId: input.tailId, outputTailId: output.tailId };
    });
  }

  async markParseFailure(input: {
    requestId: string;
    completedAtMs: number;
    state: string;
    httpStatus?: number;
    errorCode: string;
    errorMessage: string;
    ttfbMs?: number;
    totalMs?: number;
    requestBytes?: number;
    responseBytes?: number;
    rawCaptureState?: string;
  }): Promise<void> {
    await this.#serialized(async () => {
      await this.#db.run(`UPDATE requests SET completed_at_ms = ?, state = ?, http_status = ?,
        ttfb_ms = ?, total_ms = ?, request_bytes = ?, response_bytes = ?, parse_status = 'failed',
        parse_error_code = ?, parse_error_message = ?, raw_capture_state = ? WHERE id = ?`,
      input.completedAtMs, input.state, input.httpStatus ?? null, input.ttfbMs ?? null, input.totalMs ?? null,
      input.requestBytes ?? 0, input.responseBytes ?? 0, input.errorCode, input.errorMessage.slice(0, 512),
      input.rawCaptureState ?? 'unavailable', input.requestId);
    });
  }

  async getRequest(requestId: string): Promise<Record<string, unknown> | undefined> {
    return this.#db.get<Record<string, unknown>>('SELECT * FROM requests WHERE id = ?', requestId);
  }

  async resolveProviderObject(provider: Provider, objectType: string, objectId: string): Promise<{ requestId: string; outputTailId: Buffer | null } | null> {
    const row = await this.#db.get<{ request_id: string; output_tail_id: Buffer | null }>(
      'SELECT request_id, output_tail_id FROM provider_objects WHERE provider = ? AND object_type = ? AND object_id = ?',
      provider, objectType, objectId);
    return row ? { requestId: row.request_id, outputTailId: row.output_tail_id } : null;
  }

  async transcript(tailId: Buffer | null): Promise<CanonicalItem[]> {
    if (!tailId) return [];
    const items: CanonicalItem[] = [];
    let current: Buffer | null = tailId;
    while (current) {
      const row: { parent_id: Buffer | null; payload: Buffer } | undefined = await this.#db.get(`SELECT n.parent_id, i.payload
        FROM context_nodes n JOIN items i ON i.id = n.item_id WHERE n.id = ?`, current);
      if (!row) throw new Error('context tail references a missing node');
      items.push(JSON.parse(Buffer.from(await decompress(row.payload)).toString('utf8')) as CanonicalItem);
      current = row.parent_id;
    }
    return items.reverse();
  }

  async counts(): Promise<{ items: number; nodes: number; requests: number }> {
    const [items, nodes, requests] = await Promise.all([
      this.#db.get<{ count: number }>('SELECT count(*) AS count FROM items'),
      this.#db.get<{ count: number }>('SELECT count(*) AS count FROM context_nodes'),
      this.#db.get<{ count: number }>('SELECT count(*) AS count FROM requests'),
    ]);
    return { items: items?.count ?? 0, nodes: nodes?.count ?? 0, requests: requests?.count ?? 0 };
  }

  async close(): Promise<void> {
    await this.#tail;
    await this.#db.close();
  }
}
