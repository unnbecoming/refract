import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { describe, expect, test } from 'vitest';
import { DURABLE_SCHEMA, DURABLE_SCHEMA_VERSION } from '../src/storage/durable-schema.js';

describe('fresh durable schema', () => {
  test('creates the complete schema with foreign keys and fixed-width identities', async () => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    try {
      await db.exec(`PRAGMA foreign_keys = ON; ${DURABLE_SCHEMA}`);
      await db.run('INSERT INTO schema_metadata (key, value) VALUES (?, ?)', 'schema_version', DURABLE_SCHEMA_VERSION);
      const tables = await db.all<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
      expect(tables.map((row) => row.name)).toEqual([
        'context_nodes', 'items', 'provider_objects', 'request_item_occurrences', 'requests', 'schema_metadata',
      ]);
      await expect(db.run(`INSERT INTO items
        (id, schema_version, kind, payload_codec, payload, canonical_bytes, created_at_ms)
        VALUES (?, 1, 'message', 'zstd', X'00', 1, 1)`, Buffer.alloc(31))).rejects.toThrow();
      expect(await db.get<{ value: string }>('SELECT value FROM schema_metadata WHERE key = ?', 'schema_version'))
        .toEqual({ value: '1' });
    } finally {
      await db.close();
    }
  });
});
