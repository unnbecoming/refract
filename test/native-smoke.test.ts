import { compress, decompress } from '@mongodb-js/zstd';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { describe, expect, test } from 'vitest';
import { main } from '../src/entrypoint.js';

describe('phase 0 toolchain', () => {
  test('loads the backend entrypoint', () => {
    expect(typeof main).toBe('function');
  });

  test('loads native SQLite and zstd bindings', async () => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec('CREATE TABLE probe (value TEXT NOT NULL)');
    await db.run('INSERT INTO probe (value) VALUES (?)', 'alive');
    expect((await db.get<{ value: string }>('SELECT value FROM probe'))?.value).toBe('alive');
    await db.close();

    const source = Buffer.from('refract-native-smoke');
    const encoded = await compress(source);
    expect(Buffer.from(await decompress(encoded))).toEqual(source);
  });
});
