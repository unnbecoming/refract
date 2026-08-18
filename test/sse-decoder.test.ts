import { describe, expect, test } from 'vitest';
import { SseDecoder, type SseEvent } from '../src/providers/sse-decoder.js';

const source = Buffer.from([
  ': comment ignored\r\n',
  'id: 7\r\n',
  'event: greeting\r\n',
  'data: hello 🌱\r\n',
  'data: second line\r\n',
  '\r\n',
  'data\n',
  '\n',
  'data: [DONE]\n',
  '\n',
  'event: tail\n',
  'data: no final delimiter',
].join(''));

const expected: SseEvent[] = [
  { event: 'greeting', data: 'hello 🌱\nsecond line', id: '7' },
  { event: 'message', data: '', id: '7' },
  { event: 'message', data: '[DONE]', id: '7' },
  { event: 'tail', data: 'no final delimiter', id: '7' },
];

function decode(chunks: Buffer[]): SseEvent[] {
  const events: SseEvent[] = [];
  const decoder = new SseDecoder((event) => events.push(event));
  for (const chunk of chunks) decoder.push(chunk);
  decoder.finish();
  return events;
}

describe('incremental SSE decoder', () => {
  test('handles every single byte split, UTF-8 boundaries, CRLF, comments, multiline and terminal data', () => {
    expect(decode([source])).toEqual(expected);
    for (let split = 0; split <= source.length; split += 1) {
      expect(decode([source.subarray(0, split), source.subarray(split)])).toEqual(expected);
    }
    expect(decode([...source].map((_byte, index) => source.subarray(index, index + 1)))).toEqual(expected);
  });

  test('rejects malformed UTF-8 and pushes after finish', () => {
    const decoder = new SseDecoder(() => undefined);
    expect(() => { decoder.push(Uint8Array.from([0xff])); decoder.finish(); }).toThrow();
    const done = new SseDecoder(() => undefined);
    done.finish();
    expect(() => done.push(Buffer.from('data: late\n\n'))).toThrow(/after.*finish/);
  });
});
