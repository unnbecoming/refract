import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

function secretEnvironment(): { environment: NodeJS.ProcessEnv; cleanup: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-config-'));
  const anthropic = path.join(directory, 'anthropic.key');
  const openai = path.join(directory, 'openai.key');
  fs.writeFileSync(anthropic, 'anthropic-file-secret\n', { mode: 0o600 });
  fs.writeFileSync(openai, 'openai-file-secret\n', { mode: 0o600 });
  return {
    environment: {
      ANTHROPIC_ORIGIN: 'https://api.anthropic.test',
      OPENAI_ORIGIN: 'https://api.openai.test',
      ANTHROPIC_API_KEY_FILE: anthropic,
      OPENAI_API_KEY_FILE: openai,
    },
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

describe('configuration', () => {
  test('loads fixed origins, boot-frozen credentials, and conservative listener defaults', () => {
    const fixture = secretEnvironment();
    try {
      const config = loadConfig({ ...fixture.environment, SENSITIVE_HEADER_NAMES: ' X-Tenant-Token, x-extra-secret, X-Tenant-Token ' });
      expect(config.data).toEqual({ host: '127.0.0.1', port: 8340 });
      expect(config.admin.host).toBe('127.0.0.1');
      expect(config.admin.token).toBeNull();
      expect(config.upstreams.openai.href).toBe('https://api.openai.test/');
      expect(config.credentials.anthropic.wireValue).toBe('anthropic-file-secret');
      expect(config.credentials.openai.wireValue).toBe('Bearer openai-file-secret');
      expect(config.sensitiveHeaders).toEqual(['x-tenant-token', 'x-extra-secret']);
      expect(config.durablePath).toBe('/var/lib/refract/observability.db');
      expect(config.parserMaxBodyBytes).toBe(16 * 1024 * 1024);
      expect(config.rawDownloadEnabled).toBe(false);
      expect(config.limits).toEqual({ maxConcurrentRequests: 128, maxRequestBodyBytes: 64 * 1024 * 1024, maxHeaderBytes: 32 * 1024, maxConnections: 1024 });
      expect(config.raw).toMatchObject({ retentionHours: 168, blockBytes: 256 * 1024, maxQueuedWrites: 256 });
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects origin paths and unauthenticated non-loopback admin binding', () => {
    const fixture = secretEnvironment();
    try {
      expect(() => loadConfig({ ...fixture.environment, OPENAI_ORIGIN: 'https://api.openai.test/v1' })).toThrow(/without a path/);
      expect(() => loadConfig({ ...fixture.environment, ADMIN_HOST: '0.0.0.0' })).toThrow(/requires ADMIN_TOKEN_FILE/);
      expect(() => loadConfig({ ...fixture.environment, RAW_MAX_DB_BYTES: '100', RAW_TARGET_DB_BYTES: '100' })).toThrow(/must be lower/);
    } finally {
      fixture.cleanup();
    }
  });

  test('boot-freezes an admin token from a file', () => {
    const fixture = secretEnvironment();
    const directory = path.dirname(fixture.environment.ANTHROPIC_API_KEY_FILE ?? '');
    const file = path.join(directory, 'admin.token');
    fs.writeFileSync(file, 'a-strong-static-admin-token-value\n', { mode: 0o600 });
    try {
      const config = loadConfig({ ...fixture.environment, ADMIN_HOST: '0.0.0.0', ADMIN_TOKEN_FILE: file });
      expect(config.admin.token?.toString()).toBe('a-strong-static-admin-token-value');
    } finally {
      fixture.cleanup();
    }
  });
});
