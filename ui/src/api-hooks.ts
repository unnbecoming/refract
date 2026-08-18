import { useContext, useEffect, useState } from 'react';
import { ApiContext, type ApiContextValue } from './api-context.js';

export function useApi(): ApiContextValue {
  const value = useContext(ApiContext);
  if (!value) throw new Error('ApiProvider missing');
  return value;
}

interface QueryResult<T> { key: string; data: T | null; error: string | null }

export function useApiQuery<T>(path: string | null): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const { get, revision } = useApi();
  const [result, setResult] = useState<QueryResult<T>>({ key: '', data: null, error: null });
  const [nonce, setNonce] = useState(0);
  const key = path === null ? '' : `${path}\n${revision}\n${nonce}`;
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    get<T>(path, controller.signal).then((value) => setResult({ key, data: value, error: null })).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setResult({ key, data: null, error: reason instanceof Error ? reason.message : 'Request failed.' });
    });
    return () => controller.abort();
  }, [get, key, path]);
  return {
    data: path === null || result.key !== key ? null : result.data,
    loading: path !== null && result.key !== key,
    error: path === null || result.key !== key ? null : result.error,
    reload: () => setNonce((value) => value + 1),
  };
}
