import * as crypto from 'node:crypto';
import type { CanonicalItem } from './types.js';
import { canonicalJson } from './canonical-json.js';

const ITEM_DOMAIN = Buffer.from('refract:item:v1\0');
const NODE_DOMAIN = Buffer.from('refract:node:v1\0');
const ROOT_PARENT = Buffer.alloc(32);

function sha256(parts: readonly Buffer[]): Buffer {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

export function itemBytes(item: CanonicalItem): Buffer {
  return canonicalJson(item);
}

export function itemId(item: CanonicalItem): Buffer {
  return sha256([ITEM_DOMAIN, itemBytes(item)]);
}

export function nodeId(parentId: Buffer | null, canonicalItemId: Buffer): Buffer {
  const parent = parentId ?? ROOT_PARENT;
  if (parent.length !== 32 || canonicalItemId.length !== 32) throw new Error('node and item ids must be 32 bytes');
  return sha256([NODE_DOMAIN, parent, canonicalItemId]);
}
