import * as fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { AnthropicStreamParser, parseAnthropicRequest, parseAnthropicResponse } from '../src/providers/anthropic.js';
import { SseDecoder } from '../src/providers/sse-decoder.js';

interface FixtureEvent { event: string; data: unknown }
interface Fixture { request: unknown; response: unknown; events: FixtureEvent[] }
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/anthropic-messages.json', import.meta.url), 'utf8')) as Fixture;

function streaming(events: FixtureEvent[]) {
  const parser = new AnthropicStreamParser();
  const decoder = new SseDecoder((event) => parser.push(event));
  const bytes = Buffer.from(events.map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join(''));
  for (let index = 0; index < bytes.length; index += 7) decoder.push(bytes.subarray(index, index + 7));
  decoder.finish();
  return parser.finish();
}

describe('Anthropic Messages adapter', () => {
  test('canonicalizes ordered system/messages/media/tool calls and tool results', () => {
    const parsed = parseAnthropicRequest(fixture.request);
    expect(parsed.model).toBe('claude-example');
    expect(parsed.streaming).toBe(true);
    expect(parsed.items.map((item) => item.kind)).toEqual(['message', 'message', 'message', 'tool_call', 'tool_result']);
    expect(parsed.items[1]).toMatchObject({ kind: 'message', role: 'user', content: [{ type: 'text', text: 'Inspect this.' }, { type: 'media', mediaType: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }] });
    expect(parsed.items[3]).toEqual({ schemaVersion: 1, kind: 'tool_call', name: 'inspect', arguments: { depth: 2 }, callKey: 'toolu_1' });
  });

  test('streaming and non-streaming responses produce the same canonical transcript and usage', () => {
    const complete = parseAnthropicResponse(fixture.response);
    const streamed = streaming(fixture.events);
    expect(streamed.items).toEqual(complete.items);
    expect(streamed.providerResponseId).toBe(complete.providerResponseId);
    expect(streamed.model).toBe(complete.model);
    expect(streamed.stopReason).toBe(complete.stopReason);
    expect(streamed.usage).toMatchObject({ inputTokens: 5, outputTokens: 7, cachedInputTokens: 2, cacheWriteTokens: 1 });
    expect(streamed.warnings).toEqual([]);
  });

  test('preserves unknown content and stream events instead of silently discarding them', () => {
    const parsed = parseAnthropicResponse({ type: 'message', role: 'assistant', content: [{ type: 'future_block', payload: { value: 1 } }] });
    expect(parsed.items).toEqual([{ schemaVersion: 1, kind: 'unknown', provider: 'anthropic', providerType: 'future_block', payload: { type: 'future_block', payload: { value: 1 } } }]);
    const parser = new AnthropicStreamParser();
    parser.push({ event: 'future_event', data: JSON.stringify({ type: 'future_event', value: 2 }) });
    expect(parser.finish().items).toContainEqual({ schemaVersion: 1, kind: 'unknown', provider: 'anthropic', providerType: 'future_event', payload: { type: 'future_event', value: 2 } });
  });
});
