import canonicalizePackage from 'canonicalize';

const canonicalize = canonicalizePackage as unknown as (value: unknown) => string | undefined;

export function canonicalJson(value: unknown): Buffer {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new Error('value is not representable as canonical JSON');
  return Buffer.from(encoded, 'utf8');
}
