import type { Provider } from '../config.js';

export type CanonicalPart =
  | { type: 'text'; text: string }
  | { type: 'refusal'; text: string }
  | { type: 'json'; value: unknown }
  | { type: 'media'; mediaType: 'image' | 'document' | 'audio'; mimeType?: string; uri?: string; data?: string }
  | { type: 'citation'; title?: string; uri?: string; start?: number; end?: number }
  | { type: 'unknown'; provider: Provider; providerType: string; payload: unknown };

export type CanonicalItem =
  | { schemaVersion: 1; kind: 'message'; role: 'system' | 'developer' | 'user' | 'assistant'; content: CanonicalPart[] }
  | { schemaVersion: 1; kind: 'tool_call'; name: string; arguments: unknown; callKey?: string }
  | { schemaVersion: 1; kind: 'tool_result'; callKey?: string; content: CanonicalPart[]; isError?: boolean }
  | { schemaVersion: 1; kind: 'reasoning'; content: CanonicalPart[]; encryptedOrRedacted?: boolean }
  | { schemaVersion: 1; kind: 'compaction'; summary: CanonicalPart[] }
  | { schemaVersion: 1; kind: 'unknown'; provider: Provider; providerType: string; payload: unknown };
