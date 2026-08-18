import type { CanonicalItem, CanonicalPart } from '../canonical/types.js';
import { asBoolean, asNumber, asString, compactDefined, isRecord, message, parseJsonBody, unknownItem, unknownPart } from './common.js';
import type { ParsedProviderItemMetadata, ParsedProviderRequest, ParsedProviderResponse, ProviderStreamParser, ProviderUsage } from './types.js';
import type { SseEvent } from './sse-decoder.js';

function responseContentParts(value: unknown): CanonicalPart[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) return value === undefined || value === null ? [] : [unknownPart('openai', 'invalid_response_content', value)];
  const parts: CanonicalPart[] = [];
  for (const part of value) {
    if (!isRecord(part)) { parts.push(unknownPart('openai', 'invalid_response_content_part', part)); continue; }
    const type = asString(part.type) ?? 'unknown';
    if (type === 'input_text' || type === 'output_text' || type === 'summary_text' || type === 'reasoning_text') {
      parts.push({ type: 'text', text: asString(part.text) ?? '' });
      if (Array.isArray(part.annotations)) {
        for (const raw of part.annotations) {
          if (!isRecord(raw)) continue;
          const citation: Extract<CanonicalPart, { type: 'citation' }> = { type: 'citation' };
          const title = asString(raw.title) ?? asString(raw.filename);
          const uri = asString(raw.url) ?? asString(raw.file_id);
          const start = asNumber(raw.start_index);
          const end = asNumber(raw.end_index);
          if (title) citation.title = title;
          if (uri) citation.uri = uri;
          if (start !== undefined) citation.start = start;
          if (end !== undefined) citation.end = end;
          parts.push(citation);
        }
      }
    } else if (type === 'refusal') parts.push({ type: 'refusal', text: asString(part.refusal) ?? '' });
    else if (type === 'input_image') {
      const media: Extract<CanonicalPart, { type: 'media' }> = { type: 'media', mediaType: 'image' };
      const uri = asString(part.image_url) ?? asString(part.file_id);
      if (uri) media.uri = uri;
      parts.push(media);
    } else if (type === 'input_file') {
      const media: Extract<CanonicalPart, { type: 'media' }> = { type: 'media', mediaType: 'document' };
      const uri = asString(part.file_id) ?? asString(part.file_url);
      const data = asString(part.file_data);
      if (uri) media.uri = uri;
      if (data) media.data = data;
      parts.push(media);
    } else if (type === 'input_audio') {
      const media: Extract<CanonicalPart, { type: 'media' }> = { type: 'media', mediaType: 'audio' };
      const data = asString(part.data);
      const format = asString(part.format);
      if (data) media.data = data;
      if (format) media.mimeType = `audio/${format}`;
      parts.push(media);
    } else parts.push(unknownPart('openai', type, part));
  }
  return parts;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try { return value === '' ? {} : JSON.parse(value) as unknown; }
  catch { return value; }
}

function responseItem(value: unknown): CanonicalItem[] {
  if (!isRecord(value)) return [unknownItem('openai', 'invalid_response_item', value)];
  const type = asString(value.type) ?? 'unknown';
  if (type === 'message') {
    const roleValue = asString(value.role);
    const role = roleValue === 'system' || roleValue === 'developer' || roleValue === 'user' || roleValue === 'assistant' ? roleValue : 'assistant';
    return [message(role, responseContentParts(value.content))];
  }
  if (type === 'function_call') {
    const item: Extract<CanonicalItem, { kind: 'tool_call' }> = { schemaVersion: 1, kind: 'tool_call', name: asString(value.name) ?? '', arguments: parseArguments(value.arguments) };
    const callKey = asString(value.call_id) ?? asString(value.id);
    if (callKey) item.callKey = callKey;
    return [item];
  }
  if (type === 'function_call_output') {
    const item: Extract<CanonicalItem, { kind: 'tool_result' }> = { schemaVersion: 1, kind: 'tool_result', content: responseContentParts(value.output) };
    const callKey = asString(value.call_id);
    if (callKey) item.callKey = callKey;
    return [item];
  }
  if (type === 'reasoning') {
    const content = responseContentParts(value.summary ?? value.content ?? []);
    if (asString(value.encrypted_content)) content.push(unknownPart('openai', 'encrypted_reasoning', { encrypted_content: value.encrypted_content }));
    const item: Extract<CanonicalItem, { kind: 'reasoning' }> = { schemaVersion: 1, kind: 'reasoning', content };
    if (asString(value.encrypted_content)) item.encryptedOrRedacted = true;
    return [item];
  }
  if (type === 'compaction') return [{ schemaVersion: 1, kind: 'compaction', summary: responseContentParts(value.summary ?? value.content ?? []) }];
  if (type === 'item_reference') return [unknownItem('openai', type, value)];
  return [unknownItem('openai', type, value)];
}

function appendResponseItem(items: CanonicalItem[], metadata: ParsedProviderItemMetadata[], value: unknown): void {
  const providerType = isRecord(value) ? asString(value.type) ?? 'unknown' : 'invalid_response_item';
  const providerItemId = isRecord(value) ? asString(value.id) : undefined;
  for (const item of responseItem(value)) {
    items.push(item);
    const occurrence: ParsedProviderItemMetadata = { providerType };
    if (providerItemId) occurrence.providerItemId = providerItemId;
    metadata.push(occurrence);
  }
}

function appendSyntheticItem(items: CanonicalItem[], metadata: ParsedProviderItemMetadata[], item: CanonicalItem, providerType: string): void {
  items.push(item);
  metadata.push({ providerType });
}

function usage(value: unknown): ProviderUsage | undefined {
  if (!isRecord(value)) return undefined;
  const result: ProviderUsage = { raw: value };
  const inputTokens = asNumber(value.input_tokens);
  const outputTokens = asNumber(value.output_tokens);
  const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : {};
  const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : {};
  const cached = asNumber(inputDetails.cached_tokens);
  const reasoning = asNumber(outputDetails.reasoning_tokens);
  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  if (cached !== undefined) result.cachedInputTokens = cached;
  if (reasoning !== undefined) result.reasoningTokens = reasoning;
  return result;
}

function conversationId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return isRecord(value) ? asString(value.id) : undefined;
}

export function parseOpenAIResponsesRequest(body: unknown): ParsedProviderRequest {
  const value = parseJsonBody(body);
  if (!isRecord(value)) throw new Error('OpenAI Responses request must be a JSON object');
  const items: CanonicalItem[] = [];
  const itemMetadata: ParsedProviderItemMetadata[] = [];
  if (typeof value.instructions === 'string') appendSyntheticItem(items, itemMetadata, message('developer', [{ type: 'text', text: value.instructions }]), 'instructions');
  else if (value.instructions !== undefined && value.instructions !== null) appendResponseItem(items, itemMetadata, value.instructions);
  if (typeof value.input === 'string') appendSyntheticItem(items, itemMetadata, message('user', [{ type: 'text', text: value.input }]), 'input_text');
  else if (Array.isArray(value.input)) for (const item of value.input as unknown[]) appendResponseItem(items, itemMetadata, item);
  else if (value.input !== undefined) appendSyntheticItem(items, itemMetadata, unknownItem('openai', 'responses_input', value.input), 'responses_input');
  const result: ParsedProviderRequest = {
    provider: 'openai',
    streaming: asBoolean(value.stream) === true,
    items,
    itemMetadata,
    providerMetadata: compactDefined({ tools: value.tools, tool_choice: value.tool_choice, text: value.text, reasoning: value.reasoning, include: value.include, truncation: value.truncation }),
  };
  const model = asString(value.model);
  const previous = asString(value.previous_response_id);
  const conversation = conversationId(value.conversation);
  if (model) result.model = model;
  if (previous) result.previousResponseId = previous;
  if (conversation) result.providerConversationId = conversation;
  return result;
}

export function parseOpenAIResponsesResponse(body: unknown): ParsedProviderResponse {
  const value = parseJsonBody(body);
  if (!isRecord(value)) throw new Error('OpenAI Responses response must be a JSON object');
  const items: CanonicalItem[] = [];
  const itemMetadata: ParsedProviderItemMetadata[] = [];
  if (Array.isArray(value.output)) for (const item of value.output as unknown[]) appendResponseItem(items, itemMetadata, item);
  const result: ParsedProviderResponse = {
    provider: 'openai',
    items,
    itemMetadata,
    warnings: [],
    providerMetadata: compactDefined({ object: value.object, error: value.error, incomplete_details: value.incomplete_details, parallel_tool_calls: value.parallel_tool_calls }),
  };
  const id = asString(value.id);
  const model = asString(value.model);
  const conversation = conversationId(value.conversation);
  const parsedUsage = usage(value.usage);
  const status = asString(value.status);
  if (id) result.providerResponseId = id;
  if (model) result.model = model;
  if (conversation) result.providerConversationId = conversation;
  if (parsedUsage) result.usage = parsedUsage;
  if (status) result.status = status;
  return result;
}

function ensureMessagePart(item: Record<string, unknown>, contentIndex: number, type: 'output_text' | 'refusal'): Record<string, unknown> {
  const content = Array.isArray(item.content) ? item.content as unknown[] : [];
  while (content.length <= contentIndex) content.push({ type, ...(type === 'output_text' ? { text: '' } : { refusal: '' }), annotations: [] });
  const current = isRecord(content[contentIndex]) ? content[contentIndex] : { type };
  content[contentIndex] = current;
  item.content = content;
  return current;
}

export class OpenAIResponsesStreamParser implements ProviderStreamParser {
  readonly #output = new Map<number, Record<string, unknown>>();
  readonly #unknown: CanonicalItem[] = [];
  readonly #warnings: string[] = [];
  #response: Record<string, unknown> = {};
  #terminal: ParsedProviderResponse | undefined;

  push(event: SseEvent): void {
    let data: unknown;
    try { data = JSON.parse(event.data) as unknown; }
    catch { this.#warnings.push(`invalid_json:${event.event}`); return; }
    if (!isRecord(data)) { this.#unknown.push(unknownItem('openai', event.event, data)); return; }
    const type = asString(data.type) ?? event.event;
    if (['response.created', 'response.in_progress', 'response.queued'].includes(type) && isRecord(data.response)) {
      this.#response = { ...data.response, output: [] };
    } else if (type === 'response.output_item.added' && asNumber(data.output_index) !== undefined && isRecord(data.item)) {
      this.#output.set(asNumber(data.output_index)!, structuredClone(data.item));
    } else if (type === 'response.output_item.done' && asNumber(data.output_index) !== undefined && isRecord(data.item)) {
      this.#output.set(asNumber(data.output_index)!, structuredClone(data.item));
    } else if ((type === 'response.content_part.added' || type === 'response.content_part.done') && asNumber(data.output_index) !== undefined && asNumber(data.content_index) !== undefined && isRecord(data.part)) {
      const index = asNumber(data.output_index)!;
      const item = this.#output.get(index) ?? { type: 'message', role: 'assistant', content: [] };
      const content = Array.isArray(item.content) ? item.content as unknown[] : [];
      content[asNumber(data.content_index)!] = structuredClone(data.part);
      item.content = content;
      this.#output.set(index, item);
    } else if (type === 'response.output_text.delta' && asNumber(data.output_index) !== undefined && asNumber(data.content_index) !== undefined) {
      const index = asNumber(data.output_index)!;
      const item = this.#output.get(index) ?? { type: 'message', role: 'assistant', content: [] };
      const part = ensureMessagePart(item, asNumber(data.content_index)!, 'output_text');
      part.text = `${asString(part.text) ?? ''}${asString(data.delta) ?? ''}`;
      this.#output.set(index, item);
    } else if (type === 'response.refusal.delta' && asNumber(data.output_index) !== undefined && asNumber(data.content_index) !== undefined) {
      const index = asNumber(data.output_index)!;
      const item = this.#output.get(index) ?? { type: 'message', role: 'assistant', content: [] };
      const part = ensureMessagePart(item, asNumber(data.content_index)!, 'refusal');
      part.refusal = `${asString(part.refusal) ?? ''}${asString(data.delta) ?? ''}`;
      this.#output.set(index, item);
    } else if (type === 'response.function_call_arguments.delta' && asNumber(data.output_index) !== undefined) {
      const index = asNumber(data.output_index)!;
      const item = this.#output.get(index) ?? { type: 'function_call', arguments: '' };
      item.arguments = `${asString(item.arguments) ?? ''}${asString(data.delta) ?? ''}`;
      this.#output.set(index, item);
    } else if (type === 'response.reasoning_summary_text.delta' && asNumber(data.output_index) !== undefined) {
      const index = asNumber(data.output_index)!;
      const item = this.#output.get(index) ?? { type: 'reasoning', summary: [{ type: 'summary_text', text: '' }] };
      const summary = Array.isArray(item.summary) ? item.summary as unknown[] : [];
      const summaryIndex = asNumber(data.summary_index) ?? 0;
      const part = isRecord(summary[summaryIndex]) ? summary[summaryIndex] : { type: 'summary_text', text: '' };
      part.text = `${asString(part.text) ?? ''}${asString(data.delta) ?? ''}`;
      summary[summaryIndex] = part;
      item.summary = summary;
      this.#output.set(index, item);
    } else if (type === 'response.reasoning_text.delta' && asNumber(data.output_index) !== undefined) {
      const index = asNumber(data.output_index)!;
      const item = this.#output.get(index) ?? { type: 'reasoning', content: [{ type: 'reasoning_text', text: '' }] };
      const content = Array.isArray(item.content) ? item.content as unknown[] : [];
      const contentIndex = asNumber(data.content_index) ?? 0;
      const part = isRecord(content[contentIndex]) ? content[contentIndex] : { type: 'reasoning_text', text: '' };
      part.text = `${asString(part.text) ?? ''}${asString(data.delta) ?? ''}`;
      content[contentIndex] = part;
      item.content = content;
      this.#output.set(index, item);
    } else if (['response.completed', 'response.incomplete', 'response.failed'].includes(type) && isRecord(data.response)) {
      this.#terminal = parseOpenAIResponsesResponse(data.response);
    } else if (![
      'response.output_text.done', 'response.refusal.done', 'response.function_call_arguments.done',
      'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
      'response.reasoning_summary_text.done', 'response.reasoning_text.done',
    ].includes(type)) this.#unknown.push(unknownItem('openai', type, data));
  }

  finish(): ParsedProviderResponse {
    if (this.#terminal) {
      this.#terminal.items.push(...this.#unknown);
      this.#terminal.warnings.push(...this.#warnings);
      return this.#terminal;
    }
    const output = [...this.#output.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
    const parsed = parseOpenAIResponsesResponse({ ...this.#response, output });
    parsed.items.push(...this.#unknown);
    parsed.warnings.push(...this.#warnings);
    return parsed;
  }
}
