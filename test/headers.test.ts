import { describe, expect, test } from 'vitest';
import { prepareRequestHeaders } from '../src/credentials/redact.js';
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

  test('separates redacted observation headers from route-owned upstream credentials', () => {
    const prepared = prepareRequestHeaders([
      'Authorization', 'Bearer caller-placeholder',
      'X-Api-Key', 'caller-api-key',
      'Cookie', 'session=private',
      'X-Custom-Secret', 'custom-private-value',
      'X-Keep', 'visible',
    ], 'provider.test', {
      headerName: 'authorization',
      wireValue: 'Bearer provider-secret',
      secretValue: Buffer.from('provider-secret'),
    }, ['x-custom-secret']);
    expect(prepared.upstream).toEqual([
      ['Cookie', 'session=private'],
      ['X-Custom-Secret', 'custom-private-value'],
      ['X-Keep', 'visible'],
      ['Host', 'provider.test'],
      ['authorization', 'Bearer provider-secret'],
    ]);
    expect(prepared.observation).toEqual([
      ['Authorization', '[REDACTED]'],
      ['X-Api-Key', '[REDACTED]'],
      ['Cookie', '[REDACTED]'],
      ['X-Custom-Secret', '[REDACTED]'],
      ['X-Keep', 'visible'],
      ['Host', 'provider.test'],
    ]);
    const known = prepared.knownSecrets.map((value) => value.toString());
    expect(known).toEqual(expect.arrayContaining([
      'provider-secret', 'Bearer provider-secret', 'Bearer caller-placeholder', 'caller-placeholder', 'caller-api-key', 'custom-private-value',
    ]));
  });
});
