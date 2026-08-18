import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiContext, ApiError, type ApiContextValue } from './api-context.js';

function authorization(token: string): HeadersInit { return token ? { authorization: `Bearer ${token}` } : {}; }

export function ApiProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [revision, setRevision] = useState(0);
  const [eventState, setEventState] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const sequence = useRef(0);
  const invalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setToken = useCallback((value: string) => { setTokenState(value); setAuthRequired(false); }, []);
  const request = useCallback(async (path: string, signal?: AbortSignal) => {
    const options: RequestInit = { headers: authorization(token), cache: 'no-store' };
    if (signal) options.signal = signal;
    const response = await fetch(path, options);
    if (response.status === 401) { setAuthRequired(true); throw new ApiError(401, 'Admin authorization is required.'); }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      throw new ApiError(response.status, body?.error?.code ?? `HTTP ${response.status}`);
    }
    return response;
  }, [token]);
  const get = useCallback(async <T,>(path: string, signal?: AbortSignal): Promise<T> => (await request(path, signal)).json() as Promise<T>, [request]);
  const download = useCallback(async (path: string): Promise<Blob> => (await request(path)).blob(), [request]);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    const invalidate = () => {
      if (invalidateTimer.current) return;
      invalidateTimer.current = setTimeout(() => { invalidateTimer.current = null; setRevision((value) => value + 1); }, 100);
    };
    const run = async () => {
      let delay = 300;
      while (!stopped) {
        try {
          setEventState('connecting');
          const response = await request(`/api/v1/events?after=${sequence.current}`, controller.signal);
          setEventState('live');
          const reader = response.body?.getReader();
          if (!reader) throw new Error('missing event stream');
          const decoder = new TextDecoder();
          let buffer = '';
          while (!stopped) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n');
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const id = block.split('\n').find((line) => line.startsWith('id: '))?.slice(4);
              const parsed = id ? Number(id) : 0;
              if (Number.isSafeInteger(parsed) && parsed > 0) {
                if (sequence.current > 0 && parsed > sequence.current + 1) invalidate();
                sequence.current = Math.max(sequence.current, parsed);
              }
              if (block.includes('event: reset') || block.includes('data: ')) invalidate();
              boundary = buffer.indexOf('\n\n');
            }
          }
          delay = 300;
        } catch (error) {
          if (stopped || controller.signal.aborted) return;
          if (error instanceof ApiError && error.status === 401) return;
          setEventState('offline');
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 5000);
        }
      }
    };
    void run();
    return () => { stopped = true; controller.abort(); if (invalidateTimer.current) clearTimeout(invalidateTimer.current); invalidateTimer.current = null; };
  }, [request]);

  const value = useMemo<ApiContextValue>(() => ({ token, setToken, authRequired, revision, eventState, get, download }), [token, setToken, authRequired, revision, eventState, get, download]);
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

