import * as fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { OpenAIResponsesStreamParser, parseOpenAIResponsesRequest, parseOpenAIResponsesResponse } from '../src/providers/openai-responses.js';
import { SseDecoder } from '../src/providers/sse-decoder.js';

interface Fixture { request: unknown; response: unknown; events: Array<Record<string, unknown>> }
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/openai-responses.json', import.meta.url), 'utf8')) as Fixture;

function streaming(events: Array<Record<string, unknown>>) {
  const parser = new OpenAIResponsesStreamParser();
  const decoder = new SseDecoder((event) => parser.push(event));
  const bytes = Buffer.from(events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  for (let index = 0; index < bytes.length; index += 13) decoder.push(bytes.subarray(index, index + 13));
  decoder.finish();
  return parser.finish();
}

describe('OpenAI Responses adapter', () => {
  test('canonicalizes instructions, input items, explicit previous-response and conversation linkage', () => {
    const parsed = parseOpenAIResponsesRequest(fixture.request);
    expect(parsed.previousResponseId).toBe('resp_previous');
    expect(parsed.providerConversationId).toBe('conv_1');
    expect(parsed.items.map((item) => item.kind)).toEqual(['message', 'message', 'tool_result']);
    expect(parsed.items[2]).toEqual({ schemaVersion: 1, kind: 'tool_result', callKey: 'call_old', content: [{ type: 'text', text: 'done' }] });
    expect(parsed.itemMetadata).toEqual([
      { providerType: 'instructions' },
      { providerType: 'message' },
      { providerType: 'function_call_output' },
    ]);
  });

  test('streaming terminal response and non-streaming response produce matching canonical output and usage', () => {
    const complete = parseOpenAIResponsesResponse(fixture.response);
    const streamed = streaming(fixture.events);
    expect(streamed.items).toEqual(complete.items);
    expect(streamed.itemMetadata).toEqual(complete.itemMetadata);
    expect(complete.itemMetadata).toEqual([
      { providerType: 'reasoning', providerItemId: 'rs_1' },
      { providerType: 'message', providerItemId: 'msg_1' },
      { providerType: 'function_call', providerItemId: 'fc_1' },
    ]);
    expect(streamed.providerResponseId).toBe('resp_1');
    expect(streamed.providerConversationId).toBe('conv_1');
    expect(streamed.status).toBe('completed');
    expect(streamed.usage).toMatchObject({ inputTokens: 12, outputTokens: 6, cachedInputTokens: 4, reasoningTokens: 2 });
  });

  test('reconstructs output text and function arguments even without a terminal response object', () => {
    const withoutTerminal = fixture.events.filter((event) => event.type !== 'response.completed' && event.type !== 'response.output_item.done');
    const parsed = streaming(withoutTerminal);
    expect(parsed.items).toContainEqual({ schemaVersion: 1, kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'Answer.' }] });
    expect(parsed.items).toContainEqual({ schemaVersion: 1, kind: 'tool_call', name: 'finish', arguments: { ok: true }, callKey: 'call_1' });
  });

  test('reconstructs reasoning text deltas without a terminal object', () => {
    const parser = new OpenAIResponsesStreamParser();
    parser.push({ event: 'response.output_item.added', data: JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', content: [] } }) });
    parser.push({ event: 'response.reasoning_text.delta', data: JSON.stringify({ type: 'response.reasoning_text.delta', output_index: 0, content_index: 0, delta: 'thought' }) });
    expect(parser.finish().items).toContainEqual({ schemaVersion: 1, kind: 'reasoning', content: [{ type: 'text', text: 'thought' }] });
  });

  test('preserves unknown response items and future stream events', () => {
    expect(parseOpenAIResponsesResponse({ output: [{ type: 'future_item', value: 1 }] }).items).toContainEqual({ schemaVersion: 1, kind: 'unknown', provider: 'openai', providerType: 'future_item', payload: { type: 'future_item', value: 1 } });
    const parser = new OpenAIResponsesStreamParser();
    parser.push({ event: 'response.future_event', data: JSON.stringify({ type: 'response.future_event', value: 2 }) });
    expect(parser.finish().items).toContainEqual({ schemaVersion: 1, kind: 'unknown', provider: 'openai', providerType: 'response.future_event', payload: { type: 'response.future_event', value: 2 } });
  });
});
