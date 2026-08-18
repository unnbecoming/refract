import { createContext } from 'react';

export interface ApiContextValue {
  token: string;
  setToken: (token: string) => void;
  authRequired: boolean;
  revision: number;
  eventState: 'connecting' | 'live' | 'offline';
  get: <T>(path: string, signal?: AbortSignal) => Promise<T>;
  download: (path: string) => Promise<Blob>;
}

export const ApiContext = createContext<ApiContextValue | null>(null);

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
