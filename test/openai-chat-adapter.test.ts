import * as fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { OpenAIChatStreamParser, parseOpenAIChatRequest, parseOpenAIChatResponse } from '../src/providers/openai-chat.js';
import { SseDecoder } from '../src/providers/sse-decoder.js';

interface Fixture { request: unknown; response: unknown; chunks: unknown[] }
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/openai-chat.json', import.meta.url), 'utf8')) as Fixture;

function streaming(chunks: unknown[]) {
  const parser = new OpenAIChatStreamParser();
  const decoder = new SseDecoder((event) => parser.push(event));
  const bytes = Buffer.from([...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join(''));
  for (let index = 0; index < bytes.length; index += 11) decoder.push(bytes.subarray(index, index + 11));
  decoder.finish();
  return parser.finish();
}

describe('OpenAI Chat Completions adapter', () => {
  test('canonicalizes roles, multimodal parts, calls, and results in order', () => {
    const parsed = parseOpenAIChatRequest(fixture.request);
    expect(parsed.items.map((item) => item.kind)).toEqual(['message', 'message', 'message', 'tool_call', 'tool_result']);
    expect(parsed.items[1]).toMatchObject({ kind: 'message', role: 'user', content: [{ type: 'text', text: 'Weather?' }, { type: 'media', mediaType: 'image', uri: 'https://example.test/image.png' }] });
    expect(parsed.items[3]).toEqual({ schemaVersion: 1, kind: 'tool_call', name: 'weather', arguments: { city: 'Paris' }, callKey: 'call_1' });
  });

  test('streaming and non-streaming choices produce matching canonical output and usage', () => {
    const complete = parseOpenAIChatResponse(fixture.response);
    const streamed = streaming(fixture.chunks);
    expect(streamed.items).toEqual(complete.items);
    expect(streamed.providerResponseId).toBe(complete.providerResponseId);
    expect(streamed.model).toBe(complete.model);
    expect(streamed.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 3, reasoningTokens: 2 });
    expect(streamed.stopReason).toBe('tool_calls');
  });

  test('preserves additional choices as alternatives instead of serializing them as turns', () => {
    const parsed = parseOpenAIChatResponse({ choices: [
      { index: 0, message: { role: 'assistant', content: 'first' } },
      { index: 1, message: { role: 'assistant', content: 'alternative' } },
    ] });
    expect(parsed.items[0]).toMatchObject({ kind: 'message', role: 'assistant' });
    expect(parsed.items[1]).toMatchObject({ kind: 'unknown', providerType: 'chat_alternative_choice' });
  });

  test('preserves unknown future delta fields', () => {
    const parser = new OpenAIChatStreamParser();
    parser.push({ event: 'message', data: JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { role: 'assistant', future_payload: { x: 1 } } }] }) });
    expect(parser.finish().items).toContainEqual({ schemaVersion: 1, kind: 'unknown', provider: 'openai', providerType: 'chat_delta:future_payload', payload: { choice_index: 0, value: { x: 1 } } });
  });
});
