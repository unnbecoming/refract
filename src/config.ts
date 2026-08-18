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

export interface TimeoutConfig {
  upstreamHeadersMs: number;
  upstreamIdleMs: number;
  shutdownGraceMs: number;
}

export interface RefractConfig {
  data: ListenerConfig;
  admin: ListenerConfig & { token: Buffer | null };
  upstreams: UpstreamConfig;
  timeouts: TimeoutConfig;
}

const port = z.coerce.number().int().min(1).max(65_535);
const milliseconds = z.coerce.number().int().positive();
const environment = z.object({
  DATA_HOST: z.string().min(1).default('127.0.0.1'),
  DATA_PORT: port.default(8340),
  ADMIN_HOST: z.string().min(1).default('127.0.0.1'),
  ADMIN_PORT: port.default(8341),
  ADMIN_TOKEN_FILE: z.string().min(1).optional(),
  ANTHROPIC_ORIGIN: z.string().url(),
  OPENAI_ORIGIN: z.string().url(),
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

function readAdminToken(file: string | undefined): Buffer | null {
  if (!file) return null;
  const token = fs.readFileSync(file).toString('utf8').trim();
  if (Buffer.byteLength(token) < 24) throw new Error('ADMIN_TOKEN_FILE must contain at least 24 bytes');
  return Buffer.from(token);
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): RefractConfig {
  const parsed = environment.parse(source);
  const token = readAdminToken(parsed.ADMIN_TOKEN_FILE);
  if (!isLoopbackHost(parsed.ADMIN_HOST) && token === null) {
    throw new Error('a non-loopback ADMIN_HOST requires ADMIN_TOKEN_FILE');
  }
  return {
    data: { host: parsed.DATA_HOST, port: parsed.DATA_PORT },
    admin: { host: parsed.ADMIN_HOST, port: parsed.ADMIN_PORT, token },
    upstreams: {
      anthropic: parseOrigin(parsed.ANTHROPIC_ORIGIN, 'ANTHROPIC_ORIGIN'),
      openai: parseOrigin(parsed.OPENAI_ORIGIN, 'OPENAI_ORIGIN'),
    },
    timeouts: {
      upstreamHeadersMs: parsed.UPSTREAM_HEADERS_TIMEOUT_MS,
      upstreamIdleMs: parsed.UPSTREAM_IDLE_TIMEOUT_MS,
      shutdownGraceMs: parsed.SHUTDOWN_GRACE_MS,
    },
  };
}
