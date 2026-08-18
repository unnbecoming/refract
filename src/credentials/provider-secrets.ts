import type { Provider } from '../config.js';

export interface ProviderCredential {
  headerName: 'authorization' | 'x-api-key';
  wireValue: string;
  secretValue: Buffer;
}

export type ProviderCredentials = Record<Provider, ProviderCredential>;
