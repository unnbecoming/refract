export type HeaderPair = readonly [name: string, value: string];

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function pairsFromRawHeaders(rawHeaders: readonly string[]): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) pairs.push([name, value]);
  }
  return pairs;
}

export function stripHopByHopHeaders(rawHeaders: readonly string[], authority?: string): HeaderPair[] {
  const pairs = pairsFromRawHeaders(rawHeaders);
  const connectionNamed = new Set<string>();
  for (const [name, value] of pairs) {
    if (name.toLowerCase() !== 'connection') continue;
    for (const token of value.split(',')) {
      const normalized = token.trim().toLowerCase();
      if (normalized) connectionNamed.add(normalized);
    }
  }
  const filtered = pairs.filter(([name]) => {
    const normalized = name.toLowerCase();
    if (authority !== undefined && normalized === 'host') return false;
    return !HOP_BY_HOP.has(normalized) && !connectionNamed.has(normalized);
  });
  if (authority !== undefined) filtered.push(['Host', authority]);
  return filtered;
}

export function flattenHeaderPairs(pairs: readonly HeaderPair[]): string[] {
  return pairs.flatMap(([name, value]) => [name, value]);
}
