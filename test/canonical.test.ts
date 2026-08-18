import { describe, expect, test } from 'vitest';
import { canonicalJson } from '../src/canonical/canonical-json.js';
import { itemBytes, itemId, nodeId } from '../src/canonical/hashing.js';
import type { CanonicalItem } from '../src/canonical/types.js';

const first: CanonicalItem = {
  schemaVersion: 1,
  kind: 'tool_call',
  name: 'lookup',
  arguments: { z: 3, nested: { beta: true, alpha: false }, a: 1 },
  callKey: 'call-1',
};

const reordered: CanonicalItem = {
  callKey: 'call-1',
  arguments: { a: 1, nested: { alpha: false, beta: true }, z: 3 },
  name: 'lookup',
  kind: 'tool_call',
  schemaVersion: 1,
};

describe('canonical identity', () => {
  test('canonical JSON and item ids ignore object key insertion order', () => {
    expect(itemBytes(first)).toEqual(itemBytes(reordered));
    expect(itemId(first)).toEqual(itemId(reordered));
    expect(canonicalJson({ b: 2, a: 1 }).toString()).toBe('{"a":1,"b":2}');
  });

  test('node ids reuse exact prefixes and branch on parent or item changes', () => {
    const item = itemId(first);
    const root = nodeId(null, item);
    expect(nodeId(null, item)).toEqual(root);
    const next = nodeId(root, item);
    expect(next).not.toEqual(root);
    const other: CanonicalItem = { schemaVersion: 1, kind: 'message', role: 'user', content: [{ type: 'text', text: 'different' }] };
    expect(nodeId(root, itemId(other))).not.toEqual(next);
  });

  test('rejects invalid hash widths and non-JSON values', () => {
    expect(() => nodeId(Buffer.alloc(31), itemId(first))).toThrow(/32 bytes/);
    expect(() => canonicalJson(undefined)).toThrow(/not representable/);
  });
});
