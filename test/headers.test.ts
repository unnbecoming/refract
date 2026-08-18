import { describe, expect, test } from 'vitest';
import { flattenHeaderPairs, stripHopByHopHeaders } from '../src/proxy/headers.js';

describe('hop-by-hop header filtering', () => {
  test('removes standard and Connection-named fields while retaining duplicates', () => {
    const filtered = stripHopByHopHeaders([
      'Host', 'caller.invalid',
      'Connection', 'keep-alive, X-Private',
      'X-Private', 'remove-me',
      'Keep-Alive', 'timeout=5',
      'X-Dupe', 'one',
      'X-Dupe', 'two',
      'Content-Encoding', 'gzip',
    ], 'upstream.test:443');
    expect(filtered).toEqual([
      ['X-Dupe', 'one'],
      ['X-Dupe', 'two'],
      ['Content-Encoding', 'gzip'],
      ['Host', 'upstream.test:443'],
    ]);
    expect(flattenHeaderPairs(filtered)).toEqual([
      'X-Dupe', 'one', 'X-Dupe', 'two', 'Content-Encoding', 'gzip', 'Host', 'upstream.test:443',
    ]);
  });
});
