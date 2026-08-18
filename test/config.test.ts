import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

const origins = {
  ANTHROPIC_ORIGIN: 'https://api.anthropic.test',
  OPENAI_ORIGIN: 'https://api.openai.test',
};

describe('configuration', () => {
  test('loads fixed, pathless origins and conservative listener defaults', () => {
    const config = loadConfig(origins);
    expect(config.data).toEqual({ host: '127.0.0.1', port: 8340 });
    expect(config.admin.host).toBe('127.0.0.1');
    expect(config.admin.token).toBeNull();
    expect(config.upstreams.openai.href).toBe('https://api.openai.test/');
  });

  test('rejects origin paths and unauthenticated non-loopback admin binding', () => {
    expect(() => loadConfig({ ...origins, OPENAI_ORIGIN: 'https://api.openai.test/v1' })).toThrow(/without a path/);
    expect(() => loadConfig({ ...origins, ADMIN_HOST: '0.0.0.0' })).toThrow(/requires ADMIN_TOKEN_FILE/);
  });

  test('boot-freezes an admin token from a file', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-config-'));
    const file = path.join(directory, 'admin.token');
    fs.writeFileSync(file, 'a-strong-static-admin-token-value\n', { mode: 0o600 });
    try {
      const config = loadConfig({ ...origins, ADMIN_HOST: '0.0.0.0', ADMIN_TOKEN_FILE: file });
      expect(config.admin.token?.toString()).toBe('a-strong-static-admin-token-value');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
