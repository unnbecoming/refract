import * as fs from 'node:fs';
import * as net from 'node:net';
import { z } from 'zod';

export type Provider = 'anthropic' | 'openai';
export type ApiSurface = 'messages' | 'chat_completions' | 'responses';

export interface ListenerConfig {
  host: string;
  port: number;
}

export interface UpstreamConfig {
  anthropic: URL;
  openai: URL;
}

export interface CredentialConfig {
  headerName: 'authorization' | 'x-api-key';
  wireValue: string;
  secretValue: Buffer;
}

export interface TimeoutConfig {
  upstreamHeadersMs: number;
  upstreamIdleMs: number;
  shutdownGraceMs: number;
}

export interface RawCaptureConfig {
  path: string;
  retentionHours: number;
  pruneIntervalSeconds: number;
  deleteBatchSize: number;
  maxDbBytes: number;
  targetDbBytes: number;
  maxExchangeBytes: number;
  blockBytes: number;
  maxQueuedWrites: number;
}

export interface RefractConfig {
  data: ListenerConfig;
  admin: ListenerConfig & { token: Buffer | null };
  upstreams: UpstreamConfig;
  credentials: Record<Provider, CredentialConfig>;
  sensitiveHeaders: string[];
  durablePath: string;
  parserMaxBodyBytes: number;
  raw: RawCaptureConfig | null;
  timeouts: TimeoutConfig;
}

const port = z.coerce.number().int().min(1).max(65_535);
const milliseconds = z.coerce.number().int().positive();
const positiveInteger = z.coerce.number().int().positive();
const environment = z.object({
  DATA_HOST: z.string().min(1).default('127.0.0.1'),
  DATA_PORT: port.default(8340),
  ADMIN_HOST: z.string().min(1).default('127.0.0.1'),
  ADMIN_PORT: port.default(8341),
  ADMIN_TOKEN_FILE: z.string().min(1).optional(),
  ANTHROPIC_ORIGIN: z.string().url(),
  OPENAI_ORIGIN: z.string().url(),
  ANTHROPIC_API_KEY_FILE: z.string().min(1),
  OPENAI_API_KEY_FILE: z.string().min(1),
  SENSITIVE_HEADER_NAMES: z.string().default(''),
  DURABLE_DB_PATH: z.string().min(1).default('/var/lib/refract/observability.db'),
  PARSER_MAX_BODY_BYTES: positiveInteger.default(16 * 1024 * 1024),
  RAW_CAPTURE_ENABLED: z.enum(['true', 'false']).default('true'),
  RAW_DB_PATH: z.string().min(1).default('/var/cache/refract/raw.db'),
  RAW_RETENTION_HOURS: z.coerce.number().positive().default(168),
  RAW_PRUNE_INTERVAL_SECONDS: positiveInteger.default(900),
  RAW_DELETE_BATCH_SIZE: positiveInteger.default(500),
  RAW_MAX_DB_BYTES: positiveInteger.default(2 * 1024 * 1024 * 1024),
  RAW_TARGET_DB_BYTES: positiveInteger.default(1536 * 1024 * 1024),
  RAW_MAX_EXCHANGE_BYTES: positiveInteger.default(64 * 1024 * 1024),
  RAW_BLOCK_BYTES: positiveInteger.default(256 * 1024),
  RAW_MAX_QUEUED_WRITES: positiveInteger.default(256),
  UPSTREAM_HEADERS_TIMEOUT_MS: milliseconds.default(30_000),
  UPSTREAM_IDLE_TIMEOUT_MS: milliseconds.default(120_000),
  SHUTDOWN_GRACE_MS: milliseconds.default(30_000),
});

export function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') return true;
  const ip = net.isIP(host);
  return ip === 4 ? host.startsWith('127.') : ip === 6 && (host === '::1' || host === '0:0:0:0:0:0:0:1');
}

function parseOrigin(raw: string, name: string): URL {
  const origin = new URL(raw);
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error(`${name} must use http or https`);
  if (origin.username || origin.password) throw new Error(`${name} must not contain credentials`);
  if (origin.pathname !== '/' || origin.search || origin.hash) throw new Error(`${name} must be an origin without a path, query, or fragment`);
  return origin;
}

function readSecretFile(file: string, name: string, minimumBytes: number): Buffer {
  const value = fs.readFileSync(file).toString('utf8').trim();
  if (Buffer.byteLength(value) < minimumBytes) throw new Error(`${name} must contain at least ${minimumBytes} bytes`);
  return Buffer.from(value);
}

function readAdminToken(file: string | undefined): Buffer | null {
  return file ? readSecretFile(file, 'ADMIN_TOKEN_FILE', 24) : null;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): RefractConfig {
  const parsed = environment.parse(source);
  const token = readAdminToken(parsed.ADMIN_TOKEN_FILE);
  const anthropicSecret = readSecretFile(parsed.ANTHROPIC_API_KEY_FILE, 'ANTHROPIC_API_KEY_FILE', 8);
  const openaiSecret = readSecretFile(parsed.OPENAI_API_KEY_FILE, 'OPENAI_API_KEY_FILE', 8);
  if (!isLoopbackHost(parsed.ADMIN_HOST) && token === null) {
    throw new Error('a non-loopback ADMIN_HOST requires ADMIN_TOKEN_FILE');
  }
  if (parsed.RAW_TARGET_DB_BYTES >= parsed.RAW_MAX_DB_BYTES) {
    throw new Error('RAW_TARGET_DB_BYTES must be lower than RAW_MAX_DB_BYTES');
  }
  return {
    data: { host: parsed.DATA_HOST, port: parsed.DATA_PORT },
    admin: { host: parsed.ADMIN_HOST, port: parsed.ADMIN_PORT, token },
    upstreams: {
      anthropic: parseOrigin(parsed.ANTHROPIC_ORIGIN, 'ANTHROPIC_ORIGIN'),
      openai: parseOrigin(parsed.OPENAI_ORIGIN, 'OPENAI_ORIGIN'),
    },
    credentials: {
      anthropic: { headerName: 'x-api-key', wireValue: anthropicSecret.toString(), secretValue: anthropicSecret },
      openai: { headerName: 'authorization', wireValue: `Bearer ${openaiSecret.toString()}`, secretValue: openaiSecret },
    },
    sensitiveHeaders: [...new Set(parsed.SENSITIVE_HEADER_NAMES.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean))],
    durablePath: parsed.DURABLE_DB_PATH,
    parserMaxBodyBytes: parsed.PARSER_MAX_BODY_BYTES,
    raw: parsed.RAW_CAPTURE_ENABLED === 'false' ? null : {
      path: parsed.RAW_DB_PATH,
      retentionHours: parsed.RAW_RETENTION_HOURS,
      pruneIntervalSeconds: parsed.RAW_PRUNE_INTERVAL_SECONDS,
      deleteBatchSize: parsed.RAW_DELETE_BATCH_SIZE,
      maxDbBytes: parsed.RAW_MAX_DB_BYTES,
      targetDbBytes: parsed.RAW_TARGET_DB_BYTES,
      maxExchangeBytes: parsed.RAW_MAX_EXCHANGE_BYTES,
      blockBytes: parsed.RAW_BLOCK_BYTES,
      maxQueuedWrites: parsed.RAW_MAX_QUEUED_WRITES,
    },
    timeouts: {
      upstreamHeadersMs: parsed.UPSTREAM_HEADERS_TIMEOUT_MS,
      upstreamIdleMs: parsed.UPSTREAM_IDLE_TIMEOUT_MS,
      shutdownGraceMs: parsed.SHUTDOWN_GRACE_MS,
    },
  };
}
