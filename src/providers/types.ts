import type { CanonicalItem } from '../canonical/types.js';
import type { Provider } from '../config.js';
import type { SseEvent } from './sse-decoder.js';

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  raw?: unknown;
}

export interface ParsedProviderRequest {
  provider: Provider;
  model?: string;
  streaming: boolean;
  items: CanonicalItem[];
  previousResponseId?: string;
  providerConversationId?: string;
  providerMetadata?: unknown;
}

export interface ParsedProviderResponse {
  provider: Provider;
  model?: string;
  providerResponseId?: string;
  providerConversationId?: string;
  items: CanonicalItem[];
  usage?: ProviderUsage;
  status?: string;
  stopReason?: string;
  providerMetadata?: unknown;
  warnings: string[];
}

export interface ProviderStreamParser {
  push(event: SseEvent): void;
  finish(): ParsedProviderResponse;
}
