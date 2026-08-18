import type { ProviderCredential } from './provider-secrets.js';
import { pairsFromRawHeaders, stripHopByHopHeaders, type HeaderPair } from '../proxy/headers.js';

const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key']);
const SENSITIVE_OBSERVATION_HEADERS = new Set([...CREDENTIAL_HEADERS, 'cookie', 'set-cookie']);

export interface PreparedRequestHeaders {
  upstream: HeaderPair[];
  observation: HeaderPair[];
  knownSecrets: Buffer[];
}

function secretVariants(value: string): Buffer[] {
  const variants = [value];
  const bearer = /^Bearer\s+(.+)$/i.exec(value);
  if (bearer?.[1]) variants.push(bearer[1]);
  return variants.filter((item) => Buffer.byteLength(item) >= 4).map((item) => Buffer.from(item));
}

export function sanitizeHeaderPairs(
  pairs: readonly HeaderPair[],
  knownSecrets: readonly Buffer[] = [],
  customSensitiveHeaders: readonly string[] = [],
): HeaderPair[] {
  const custom = new Set(customSensitiveHeaders.map((name) => name.toLowerCase()));
  return pairs.map(([name, value]) => {
    const containsSecret = knownSecrets.some((secret) => secret.length >= 4 && Buffer.from(value).indexOf(secret) !== -1);
    return SENSITIVE_OBSERVATION_HEADERS.has(name.toLowerCase()) || custom.has(name.toLowerCase()) || containsSecret
      ? [name, '[REDACTED]'] as const
      : [name, value] as const;
  });
}

export function sanitizeRawHeaders(
  rawHeaders: readonly string[],
  knownSecrets: readonly Buffer[] = [],
  customSensitiveHeaders: readonly string[] = [],
): HeaderPair[] {
  return sanitizeHeaderPairs(pairsFromRawHeaders(rawHeaders), knownSecrets, customSensitiveHeaders);
}

export function prepareRequestHeaders(
  rawHeaders: readonly string[],
  authority: string,
  credential: ProviderCredential,
  customSensitiveHeaders: readonly string[] = [],
): PreparedRequestHeaders {
  const transport = stripHopByHopHeaders(rawHeaders, authority);
  const custom = new Set(customSensitiveHeaders.map((name) => name.toLowerCase()));
  const inboundCredentialPairs = transport.filter(([name]) => CREDENTIAL_HEADERS.has(name.toLowerCase()));
  const customSecretPairs = transport.filter(([name]) => custom.has(name.toLowerCase()));
  const withoutCredentials = transport.filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase()));
  const knownSecrets = [credential.secretValue, Buffer.from(credential.wireValue)];
  for (const [, value] of [...inboundCredentialPairs, ...customSecretPairs]) knownSecrets.push(...secretVariants(value));
  return {
    upstream: [...withoutCredentials, [credential.headerName, credential.wireValue]],
    observation: sanitizeHeaderPairs(transport, knownSecrets, customSensitiveHeaders),
    knownSecrets,
  };
}
