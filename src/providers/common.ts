import type { CanonicalItem, CanonicalPart } from '../canonical/types.js';
import type { Provider } from '../config.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function parseJsonBody(body: unknown): unknown {
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf8')) as unknown;
  if (typeof body === 'string') return JSON.parse(body) as unknown;
  return body;
}

export function unknownItem(provider: Provider, providerType: string, payload: unknown): CanonicalItem {
  return { schemaVersion: 1, kind: 'unknown', provider, providerType, payload };
}

export function unknownPart(provider: Provider, providerType: string, payload: unknown): CanonicalPart {
  return { type: 'unknown', provider, providerType, payload };
}

export function message(role: 'system' | 'developer' | 'user' | 'assistant', content: CanonicalPart[]): CanonicalItem {
  return { schemaVersion: 1, kind: 'message', role, content };
}

export function compactDefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
