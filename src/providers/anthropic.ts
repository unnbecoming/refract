import type { CanonicalItem, CanonicalPart } from '../canonical/types.js';
import { asBoolean, asNumber, asString, compactDefined, isRecord, message, parseJsonBody, unknownItem, unknownPart } from './common.js';
import type { ParsedProviderRequest, ParsedProviderResponse, ProviderStreamParser, ProviderUsage } from './types.js';
import type { SseEvent } from './sse-decoder.js';

function contentParts(value: unknown): CanonicalPart[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) return [unknownPart('anthropic', 'invalid_content', value)];
  const parts: CanonicalPart[] = [];
  for (const block of value) {
    if (!isRecord(block)) { parts.push(unknownPart('anthropic', 'invalid_content_block', block)); continue; }
    const type = asString(block.type) ?? 'unknown';
    if (type === 'text') parts.push({ type: 'text', text: asString(block.text) ?? '' });
    else if (type === 'image' || type === 'document') {
      const source = isRecord(block.source) ? block.source : {};
      const sourceType = asString(source.type);
      const part: Extract<CanonicalPart, { type: 'media' }> = { type: 'media', mediaType: type };
      const mimeType = asString(source.media_type);
      const data = asString(source.data);
      const uri = asString(source.url);
      if (mimeType) part.mimeType = mimeType;
      if (sourceType === 'base64' && data) part.data = data;
      if ((sourceType === 'url' || sourceType === 'text') && uri) part.uri = uri;
      parts.push(part);
    } else parts.push(unknownPart('anthropic', type, block));
  }
  return parts;
}

function blocksToItems(role: 'system' | 'user' | 'assistant', content: unknown): CanonicalItem[] {
  if (typeof content === 'string') return [message(role, [{ type: 'text', text: content }])];
  if (!Array.isArray(content)) return [unknownItem('anthropic', 'invalid_message_content', content)];
  const items: CanonicalItem[] = [];
  let parts: CanonicalPart[] = [];
  const flush = () => { if (parts.length > 0) { items.push(message(role, parts)); parts = []; } };
  for (const block of content) {
    if (!isRecord(block)) { parts.push(unknownPart('anthropic', 'invalid_content_block', block)); continue; }
    const type = asString(block.type) ?? 'unknown';
    if (type === 'text' || type === 'image' || type === 'document') parts.push(...contentParts([block]));
    else if (type === 'tool_use') {
      flush();
      const item: Extract<CanonicalItem, { kind: 'tool_call' }> = { schemaVersion: 1, kind: 'tool_call', name: asString(block.name) ?? '', arguments: block.input ?? {} };
      const callKey = asString(block.id);
      if (callKey) item.callKey = callKey;
      items.push(item);
    } else if (type === 'tool_result') {
      flush();
      const item: Extract<CanonicalItem, { kind: 'tool_result' }> = { schemaVersion: 1, kind: 'tool_result', content: contentParts(block.content ?? '') };
      const callKey = asString(block.tool_use_id);
      if (callKey) item.callKey = callKey;
      if (asBoolean(block.is_error) === true) item.isError = true;
      items.push(item);
    } else if (type === 'thinking') {
      flush();
      items.push({ schemaVersion: 1, kind: 'reasoning', content: [{ type: 'text', text: asString(block.thinking) ?? '' }] });
    } else if (type === 'redacted_thinking') {
      flush();
      items.push({ schemaVersion: 1, kind: 'reasoning', content: [unknownPart('anthropic', type, block)], encryptedOrRedacted: true });
    } else {
      flush();
      items.push(unknownItem('anthropic', type, block));
    }
  }
  flush();
  return items;
}

function usage(value: unknown): ProviderUsage | undefined {
  if (!isRecord(value)) return undefined;
  const result: ProviderUsage = { raw: value };
  const inputTokens = asNumber(value.input_tokens);
  const outputTokens = asNumber(value.output_tokens);
  const cachedInputTokens = asNumber(value.cache_read_input_tokens);
  const cacheWriteTokens = asNumber(value.cache_creation_input_tokens);
  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  if (cachedInputTokens !== undefined) result.cachedInputTokens = cachedInputTokens;
  if (cacheWriteTokens !== undefined) result.cacheWriteTokens = cacheWriteTokens;
  return result;
}

export function parseAnthropicRequest(body: unknown): ParsedProviderRequest {
  const value = parseJsonBody(body);
  if (!isRecord(value)) throw new Error('Anthropic request must be a JSON object');
  const items: CanonicalItem[] = [];
  if (value.system !== undefined) items.push(...blocksToItems('system', value.system));
  if (!Array.isArray(value.messages)) throw new Error('Anthropic request messages must be an array');
  for (const entry of value.messages) {
    if (!isRecord(entry)) { items.push(unknownItem('anthropic', 'invalid_message', entry)); continue; }
    const role = entry.role === 'assistant' ? 'assistant' : entry.role === 'user' ? 'user' : null;
    if (!role) items.push(unknownItem('anthropic', 'message', entry));
    else items.push(...blocksToItems(role, entry.content));
  }
  const result: ParsedProviderRequest = {
    provider: 'anthropic',
    streaming: asBoolean(value.stream) === true,
    items,
    providerMetadata: compactDefined({ max_tokens: value.max_tokens, tools: value.tools, tool_choice: value.tool_choice, thinking: value.thinking }),
  };
  const model = asString(value.model);
  if (model) result.model = model;
  return result;
}

export function parseAnthropicResponse(body: unknown): ParsedProviderResponse {
  const value = parseJsonBody(body);
  if (!isRecord(value)) throw new Error('Anthropic response must be a JSON object');
  if (value.type === 'error') return { provider: 'anthropic', items: [unknownItem('anthropic', 'error', value)], warnings: ['provider_error'], providerMetadata: value };
  const result: ParsedProviderResponse = {
    provider: 'anthropic',
    items: blocksToItems('assistant', value.content),
    warnings: [],
    providerMetadata: compactDefined({ type: value.type, stop_sequence: value.stop_sequence }),
  };
  const providerResponseId = asString(value.id);
  const model = asString(value.model);
  const parsedUsage = usage(value.usage);
  const stopReason = asString(value.stop_reason);
  if (providerResponseId) result.providerResponseId = providerResponseId;
  if (model) result.model = model;
  if (parsedUsage) result.usage = parsedUsage;
  if (stopReason) result.stopReason = stopReason;
  return result;
}

export class AnthropicStreamParser implements ProviderStreamParser {
  #message: Record<string, unknown> = { type: 'message', role: 'assistant', content: [] };
  readonly #blocks = new Map<number, Record<string, unknown>>();
  readonly #unknownEvents: CanonicalItem[] = [];
  readonly #warnings: string[] = [];
  #usage: unknown;

  push(event: SseEvent): void {
    let data: unknown;
    try { data = JSON.parse(event.data) as unknown; }
    catch { this.#warnings.push(`invalid_json:${event.event}`); return; }
    if (!isRecord(data)) { this.#unknownEvents.push(unknownItem('anthropic', event.event, data)); return; }
    const type = asString(data.type) ?? event.event;
    if (type === 'message_start' && isRecord(data.message)) {
      this.#message = { ...data.message, content: [] };
      this.#usage = data.message.usage;
    } else if (type === 'content_block_start' && asNumber(data.index) !== undefined && isRecord(data.content_block)) {
      this.#blocks.set(asNumber(data.index)!, structuredClone(data.content_block));
    } else if (type === 'content_block_delta' && asNumber(data.index) !== undefined && isRecord(data.delta)) {
      const index = asNumber(data.index)!;
      const block = this.#blocks.get(index) ?? { type: 'unknown_stream_block' };
      const deltaType = asString(data.delta.type);
      if (deltaType === 'text_delta') block.text = `${asString(block.text) ?? ''}${asString(data.delta.text) ?? ''}`;
      else if (deltaType === 'thinking_delta') block.thinking = `${asString(block.thinking) ?? ''}${asString(data.delta.thinking) ?? ''}`;
      else if (deltaType === 'signature_delta') block.signature = `${asString(block.signature) ?? ''}${asString(data.delta.signature) ?? ''}`;
      else if (deltaType === 'input_json_delta') block.__partial_json = `${asString(block.__partial_json) ?? ''}${asString(data.delta.partial_json) ?? ''}`;
      else this.#unknownEvents.push(unknownItem('anthropic', deltaType ?? type, data));
      this.#blocks.set(index, block);
    } else if (type === 'content_block_stop' && asNumber(data.index) !== undefined) {
      const block = this.#blocks.get(asNumber(data.index)!);
      if (block && typeof block.__partial_json === 'string') {
        try { block.input = block.__partial_json === '' ? {} : JSON.parse(block.__partial_json) as unknown; }
        catch { this.#warnings.push(`invalid_tool_json:${String(data.index)}`); block.input = block.__partial_json; }
        delete block.__partial_json;
      }
    } else if (type === 'message_delta') {
      if (isRecord(data.delta)) Object.assign(this.#message, data.delta);
      if (data.usage !== undefined) this.#usage = { ...(isRecord(this.#usage) ? this.#usage : {}), ...(isRecord(data.usage) ? data.usage : {}) };
    } else if (!['message_stop', 'ping'].includes(type)) this.#unknownEvents.push(unknownItem('anthropic', type, data));
  }

  finish(): ParsedProviderResponse {
    const content = [...this.#blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
    const result: ParsedProviderResponse = {
      provider: 'anthropic',
      items: [...blocksToItems('assistant', content), ...this.#unknownEvents],
      warnings: this.#warnings,
      providerMetadata: compactDefined({ type: this.#message.type, stop_sequence: this.#message.stop_sequence }),
    };
    const providerResponseId = asString(this.#message.id);
    const model = asString(this.#message.model);
    const parsedUsage = usage(this.#usage);
    const stopReason = asString(this.#message.stop_reason);
    if (providerResponseId) result.providerResponseId = providerResponseId;
    if (model) result.model = model;
    if (parsedUsage) result.usage = parsedUsage;
    if (stopReason) result.stopReason = stopReason;
    return result;
  }
}
