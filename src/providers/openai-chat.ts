import type { CanonicalItem, CanonicalPart } from '../canonical/types.js';
import { asBoolean, asNumber, asString, compactDefined, isRecord, message, parseJsonBody, unknownItem, unknownPart } from './common.js';
import type { ParsedProviderRequest, ParsedProviderResponse, ProviderStreamParser, ProviderUsage } from './types.js';
import type { SseEvent } from './sse-decoder.js';

function contentParts(value: unknown): CanonicalPart[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (value === null) return [];
  if (!Array.isArray(value)) return [unknownPart('openai', 'invalid_chat_content', value)];
  const parts: CanonicalPart[] = [];
  for (const part of value) {
    if (!isRecord(part)) { parts.push(unknownPart('openai', 'invalid_chat_content_part', part)); continue; }
    const type = asString(part.type) ?? 'unknown';
    if (['text', 'input_text', 'output_text'].includes(type)) parts.push({ type: 'text', text: asString(part.text) ?? '' });
    else if (type === 'refusal') parts.push({ type: 'refusal', text: asString(part.refusal) ?? asString(part.text) ?? '' });
    else if (type === 'image_url' && isRecord(part.image_url)) {
      const media: Extract<CanonicalPart, { type: 'media' }> = { type: 'media', mediaType: 'image' };
      const uri = asString(part.image_url.url);
      if (uri) media.uri = uri;
      parts.push(media);
    } else if (type === 'input_audio' && isRecord(part.input_audio)) {
      const media: Extract<CanonicalPart, { type: 'media' }> = { type: 'media', mediaType: 'audio' };
      const data = asString(part.input_audio.data);
      const format = asString(part.input_audio.format);
      if (data) media.data = data;
      if (format) media.mimeType = `audio/${format}`;
      parts.push(media);
    } else if (type === 'file' && isRecord(part.file)) {
      const media: Extract<CanonicalPart, { type: 'media' }> = { type: 'media', mediaType: 'document' };
      const uri = asString(part.file.file_id);
      const data = asString(part.file.file_data);
      if (uri) media.uri = uri;
      if (data) media.data = data;
      parts.push(media);
    } else parts.push(unknownPart('openai', type, part));
  }
  return parts;
}

function toolCall(value: Record<string, unknown>): CanonicalItem {
  const fn = isRecord(value.function) ? value.function : {};
  const rawArguments = fn.arguments ?? value.arguments ?? {};
  let argumentsValue: unknown = rawArguments;
  if (typeof rawArguments === 'string') {
    try { argumentsValue = rawArguments === '' ? {} : JSON.parse(rawArguments) as unknown; }
    catch { argumentsValue = rawArguments; }
  }
  const item: Extract<CanonicalItem, { kind: 'tool_call' }> = {
    schemaVersion: 1,
    kind: 'tool_call',
    name: asString(fn.name) ?? asString(value.name) ?? '',
    arguments: argumentsValue,
  };
  const callKey = asString(value.id) ?? asString(value.call_id);
  if (callKey) item.callKey = callKey;
  return item;
}

function messageItems(value: Record<string, unknown>): CanonicalItem[] {
  const roleValue = asString(value.role);
  if (roleValue === 'tool') {
    const item: Extract<CanonicalItem, { kind: 'tool_result' }> = { schemaVersion: 1, kind: 'tool_result', content: contentParts(value.content) };
    const callKey = asString(value.tool_call_id);
    if (callKey) item.callKey = callKey;
    return [item];
  }
  if (roleValue === 'function') {
    const item: Extract<CanonicalItem, { kind: 'tool_result' }> = { schemaVersion: 1, kind: 'tool_result', content: contentParts(value.content) };
    const callKey = asString(value.name);
    if (callKey) item.callKey = callKey;
    return [item];
  }
  const role = roleValue === 'system' || roleValue === 'developer' || roleValue === 'user' || roleValue === 'assistant' ? roleValue : null;
  if (!role) return [unknownItem('openai', 'chat_message', value)];
  const parts = contentParts(value.content);
  if (typeof value.refusal === 'string') parts.push({ type: 'refusal', text: value.refusal });
  if (Array.isArray(value.annotations)) {
    for (const annotation of value.annotations) {
      if (!isRecord(annotation)) continue;
      const citation: Extract<CanonicalPart, { type: 'citation' }> = { type: 'citation' };
      const source = isRecord(annotation.url_citation) ? annotation.url_citation : annotation;
      const title = asString(source.title);
      const uri = asString(source.url);
      const start = asNumber(source.start_index);
      const end = asNumber(source.end_index);
      if (title) citation.title = title;
      if (uri) citation.uri = uri;
      if (start !== undefined) citation.start = start;
      if (end !== undefined) citation.end = end;
      parts.push(citation);
    }
  }
  const items: CanonicalItem[] = [];
  if (parts.length > 0 || value.content !== undefined) items.push(message(role, parts));
  if (Array.isArray(value.tool_calls)) for (const call of value.tool_calls) items.push(isRecord(call) ? toolCall(call) : unknownItem('openai', 'chat_tool_call', call));
  if (isRecord(value.function_call)) items.push(toolCall(value.function_call));
  return items;
}

function usage(value: unknown): ProviderUsage | undefined {
  if (!isRecord(value)) return undefined;
  const result: ProviderUsage = { raw: value };
  const inputTokens = asNumber(value.prompt_tokens);
  const outputTokens = asNumber(value.completion_tokens);
  const inputDetails = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const outputDetails = isRecord(value.completion_tokens_details) ? value.completion_tokens_details : {};
  const cached = asNumber(inputDetails.cached_tokens);
  const reasoning = asNumber(outputDetails.reasoning_tokens);
  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  if (cached !== undefined) result.cachedInputTokens = cached;
  if (reasoning !== undefined) result.reasoningTokens = reasoning;
  return result;
}

export function parseOpenAIChatRequest(body: unknown): ParsedProviderRequest {
  const value = parseJsonBody(body);
  if (!isRecord(value) || !Array.isArray(value.messages)) throw new Error('OpenAI Chat request messages must be an array');
  const items: CanonicalItem[] = [];
  for (const entry of value.messages) items.push(...(isRecord(entry) ? messageItems(entry) : [unknownItem('openai', 'chat_message', entry)]));
  const result: ParsedProviderRequest = {
    provider: 'openai',
    streaming: asBoolean(value.stream) === true,
    items,
    providerMetadata: compactDefined({ tools: value.tools, tool_choice: value.tool_choice, response_format: value.response_format, modalities: value.modalities }),
  };
  const model = asString(value.model);
  if (model) result.model = model;
  return result;
}

export function parseOpenAIChatResponse(body: unknown): ParsedProviderResponse {
  const value = parseJsonBody(body);
  if (!isRecord(value)) throw new Error('OpenAI Chat response must be a JSON object');
  const items: CanonicalItem[] = [];
  if (Array.isArray(value.choices)) {
    const choices = (value.choices as unknown[]).slice().sort((a, b) => (isRecord(a) ? asNumber(a.index) ?? 0 : 0) - (isRecord(b) ? asNumber(b.index) ?? 0 : 0));
    for (const [ordinal, choice] of choices.entries()) {
      if (ordinal === 0 && isRecord(choice) && isRecord(choice.message)) items.push(...messageItems(choice.message));
      else items.push(unknownItem('openai', ordinal === 0 ? 'chat_choice' : 'chat_alternative_choice', choice));
    }
  }
  const result: ParsedProviderResponse = { provider: 'openai', items, warnings: [], providerMetadata: compactDefined({ object: value.object, service_tier: value.service_tier, system_fingerprint: value.system_fingerprint }) };
  const id = asString(value.id);
  const model = asString(value.model);
  const parsedUsage = usage(value.usage);
  if (id) result.providerResponseId = id;
  if (model) result.model = model;
  if (parsedUsage) result.usage = parsedUsage;
  return result;
}

interface StreamChoice {
  role?: string;
  content: string;
  refusal: string;
  toolCalls: Map<number, Record<string, unknown>>;
  finishReason?: string;
}

export class OpenAIChatStreamParser implements ProviderStreamParser {
  readonly #choices = new Map<number, StreamChoice>();
  readonly #unknown: CanonicalItem[] = [];
  readonly #warnings: string[] = [];
  #id: string | undefined;
  #model: string | undefined;
  #usage: unknown;

  push(event: SseEvent): void {
    if (event.data === '[DONE]') return;
    let data: unknown;
    try { data = JSON.parse(event.data) as unknown; }
    catch { this.#warnings.push('invalid_json'); return; }
    if (!isRecord(data)) { this.#unknown.push(unknownItem('openai', 'chat_chunk', data)); return; }
    this.#id = asString(data.id) ?? this.#id;
    this.#model = asString(data.model) ?? this.#model;
    if (data.usage !== undefined) this.#usage = data.usage;
    if (!Array.isArray(data.choices)) return;
    for (const rawChoice of data.choices) {
      if (!isRecord(rawChoice)) { this.#unknown.push(unknownItem('openai', 'chat_choice_chunk', rawChoice)); continue; }
      const index = asNumber(rawChoice.index) ?? 0;
      const choice: StreamChoice = this.#choices.get(index) ?? { content: '', refusal: '', toolCalls: new Map<number, Record<string, unknown>>() };
      if (isRecord(rawChoice.delta)) {
        const delta = rawChoice.delta;
        const role = asString(delta.role);
        if (role) choice.role = role;
        choice.content += asString(delta.content) ?? '';
        choice.refusal += asString(delta.refusal) ?? '';
        if (isRecord(delta.function_call)) {
          const call = choice.toolCalls.get(-1) ?? { type: 'function', function: {} };
          const fn = isRecord(call.function) ? call.function : {};
          if (asString(delta.function_call.name)) fn.name = delta.function_call.name;
          fn.arguments = `${asString(fn.arguments) ?? ''}${asString(delta.function_call.arguments) ?? ''}`;
          call.function = fn;
          choice.toolCalls.set(-1, call);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const rawCall of delta.tool_calls) {
            if (!isRecord(rawCall)) { this.#unknown.push(unknownItem('openai', 'chat_tool_call_delta', rawCall)); continue; }
            const callIndex = asNumber(rawCall.index) ?? 0;
            const call = choice.toolCalls.get(callIndex) ?? {};
            if (asString(rawCall.id)) call.id = rawCall.id;
            if (asString(rawCall.type)) call.type = rawCall.type;
            if (isRecord(rawCall.function)) {
              const fn = isRecord(call.function) ? call.function : {};
              if (asString(rawCall.function.name)) fn.name = rawCall.function.name;
              fn.arguments = `${asString(fn.arguments) ?? ''}${asString(rawCall.function.arguments) ?? ''}`;
              call.function = fn;
            }
            choice.toolCalls.set(callIndex, call);
          }
        }
        for (const [key, value] of Object.entries(delta)) {
          if (!['role', 'content', 'refusal', 'tool_calls', 'function_call'].includes(key)) {
            this.#unknown.push(unknownItem('openai', `chat_delta:${key}`, { choice_index: index, value }));
          }
        }
      }
      const finishReason = asString(rawChoice.finish_reason);
      if (finishReason) choice.finishReason = finishReason;
      this.#choices.set(index, choice);
    }
  }

  finish(): ParsedProviderResponse {
    const items: CanonicalItem[] = [];
    const stopReasons: string[] = [];
    for (const [ordinal, [choiceIndex, choice]] of [...this.#choices.entries()].sort(([a], [b]) => a - b).entries()) {
      const value: Record<string, unknown> = { role: choice.role ?? 'assistant', content: choice.content };
      if (choice.refusal) value.refusal = choice.refusal;
      if (choice.toolCalls.size > 0) value.tool_calls = [...choice.toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
      if (ordinal === 0) items.push(...messageItems(value));
      else items.push(unknownItem('openai', 'chat_alternative_choice', { index: choiceIndex, message: value, finish_reason: choice.finishReason ?? null }));
      if (choice.finishReason) stopReasons.push(choice.finishReason);
    }
    const result: ParsedProviderResponse = { provider: 'openai', items: [...items, ...this.#unknown], warnings: this.#warnings, providerMetadata: { finish_reasons: stopReasons } };
    if (this.#id) result.providerResponseId = this.#id;
    if (this.#model) result.model = this.#model;
    const parsedUsage = usage(this.#usage);
    if (parsedUsage) result.usage = parsedUsage;
    if (stopReasons.length > 0) result.stopReason = stopReasons.join(',');
    return result;
  }
}
