import { compress, decompress } from '@mongodb-js/zstd';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { buildInfo } from '../src/entrypoint.js';

describe('phase 0 toolchain', () => {
  test('loads the backend entrypoint', () => {
    expect(buildInfo()).toEqual({ name: 'refract', phase: 0 });
  });

  test('loads native SQLite and zstd bindings', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE probe (value TEXT NOT NULL)');
    db.prepare('INSERT INTO probe (value) VALUES (?)').run('alive');
    expect(db.prepare('SELECT value FROM probe').pluck().get()).toBe('alive');
    db.close();

    const source = Buffer.from('refract-native-smoke');
    const encoded = await compress(source);
    expect(Buffer.from(await decompress(encoded))).toEqual(source);
  });
});
