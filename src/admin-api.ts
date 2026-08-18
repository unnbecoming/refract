import * as fs from 'node:fs';
import type * as http from 'node:http';
import type { RefractConfig, Provider, ApiSurface } from './config.js';
import { log } from './logging.js';
import type { LifecycleTracker } from './proxy/lifecycle.js';
import type { DurableStore, RequestFilters } from './storage/durable-store.js';
import type { RawCaptureState, RawCaptureStore } from './storage/raw-store.js';
import type { LiveEventHub } from './api-events.js';

interface AdminDependencies {
  config: RefractConfig;
  lifecycle: LifecycleTracker;
  events: LiveEventHub;
  durable: () => DurableStore | null;
  raw: () => RawCaptureStore | null;
  durableStatus: () => { startupFailed: boolean; recoveredRequests: number };
  rawStatus: () => { startupFailed: boolean };
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.length), 'cache-control': 'no-store' });
  response.end(body);
}

function parseInteger(value: string | null, name: string, minimum = 0): number | undefined {
  if (value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`invalid_${name}`);
  return parsed;
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('invalid_id');
  return value;
}

function fileBytes(filename: string): number {
  try { return fs.statSync(filename).size; }
  catch { return 0; }
}

function rawState(stored: unknown, retained: RawCaptureState | undefined, enabled: boolean): string {
  if (!enabled) return 'disabled';
  if (retained) return retained === 'complete' ? 'retained' : retained;
  return stored === 'complete' ? 'expired' : typeof stored === 'string' ? stored : 'not_retained';
}

function provider(value: string | null): Provider | undefined {
  if (value === null || value === '') return undefined;
  if (value !== 'anthropic' && value !== 'openai') throw new Error('invalid_provider');
  return value;
}

function surface(value: string | null): ApiSurface | undefined {
  if (value === null || value === '') return undefined;
  if (value !== 'messages' && value !== 'chat_completions' && value !== 'responses') throw new Error('invalid_surface');
  return value;
}

export function createAdminApi(dependencies: AdminDependencies) {
  return async (request: http.IncomingMessage, response: http.ServerResponse): Promise<boolean> => {
    if (request.method !== 'GET') return false;
    const url = new URL(request.url ?? '/', 'http://admin.invalid');
    const { pathname, searchParams } = url;
    const durable = dependencies.durable();
    const raw = dependencies.raw();

    try {
      if (pathname === '/api/v1/transport') {
        json(response, 200, {
          ...dependencies.lifecycle.snapshot(),
          durable: { available: durable !== null, ...dependencies.durableStatus() },
          raw: { enabled: dependencies.config.raw !== null, available: raw !== null, ...dependencies.rawStatus(), ...(raw?.stats() ?? {}) },
          events: dependencies.events.stats(),
        });
        return true;
      }

      if (pathname === '/api/v1/events') {
        const after = parseInteger(searchParams.get('after'), 'after') ?? 0;
        dependencies.events.stream(request, response, after);
        return true;
      }

      if (pathname === '/api/v1/requests') {
        if (!durable) { json(response, 503, { error: { code: 'durable_unavailable' } }); return true; }
        const filters: RequestFilters = {};
        const cursor = searchParams.get('cursor');
        if (cursor) filters.cursor = cursor;
        const limit = parseInteger(searchParams.get('limit'), 'limit', 1);
        if (limit !== undefined) filters.limit = limit;
        const selectedProvider = provider(searchParams.get('provider'));
        if (selectedProvider) filters.provider = selectedProvider;
        const selectedSurface = surface(searchParams.get('surface'));
        if (selectedSurface) filters.surface = selectedSurface;
        for (const [query, key] of [['model', 'model'], ['state', 'state'], ['parse_status', 'parseStatus'], ['raw_state', 'rawState']] as const) {
          const value = searchParams.get(query);
          if (value) filters[key] = value.slice(0, 256);
        }
        const httpStatus = parseInteger(searchParams.get('http_status'), 'http_status', 100);
        if (httpStatus !== undefined) filters.httpStatus = httpStatus;
        const fromMs = parseInteger(searchParams.get('from'), 'from');
        if (fromMs !== undefined) filters.fromMs = fromMs;
        const toMs = parseInteger(searchParams.get('to'), 'to');
        if (toMs !== undefined) filters.toMs = toMs;
        const page = await durable.listRequests(filters);
        const ids = page.items.map((item) => item.id).filter((id): id is string => typeof id === 'string');
        const retained = raw ? await raw.retainedStates(ids) : new Map<string, RawCaptureState>();
        for (const item of page.items) item.raw_state = rawState(item.raw_capture_state, typeof item.id === 'string' ? retained.get(item.id) : undefined, dependencies.config.raw !== null);
        json(response, 200, page);
        return true;
      }

      const requestMatch = pathname.match(/^\/api\/v1\/requests\/([A-Za-z0-9_-]{1,128})(?:\/(transcript))?$/);
      if (requestMatch) {
        if (!durable) { json(response, 503, { error: { code: 'durable_unavailable' } }); return true; }
        const requestId = safeId(requestMatch[1] ?? '');
        if (requestMatch[2] === 'transcript') {
          const transcript = await durable.requestTranscript(requestId);
          json(response, transcript ? 200 : 404, transcript ?? { error: { code: 'request_not_found' } });
          return true;
        }
        const detail = await durable.requestDetail(requestId);
        if (!detail) { json(response, 404, { error: { code: 'request_not_found' } }); return true; }
        const retained = raw ? (await raw.retainedStates([requestId])).get(requestId) : undefined;
        detail.raw_state = rawState(detail.raw_capture_state, retained, dependencies.config.raw !== null);
        detail.raw_download_enabled = dependencies.config.rawDownloadEnabled;
        json(response, 200, detail);
        return true;
      }

      const contextMatch = pathname.match(/^\/api\/v1\/contexts\/([a-fA-F0-9]{64})\/transcript$/);
      if (contextMatch) {
        if (!durable) { json(response, 503, { error: { code: 'durable_unavailable' } }); return true; }
        const tailId = contextMatch[1] ?? '';
        const items = await durable.transcriptByHex(tailId);
        json(response, items ? 200 : 404, items ? { tailId, items } : { error: { code: 'context_not_found' } });
        return true;
      }

      const lineageMatch = pathname.match(/^\/api\/v1\/lineages\/([A-Za-z0-9_-]{1,128})$/);
      if (lineageMatch) {
        if (!durable) { json(response, 503, { error: { code: 'durable_unavailable' } }); return true; }
        const requestId = safeId(lineageMatch[1] ?? '');
        const lineage = await durable.lineage(requestId);
        json(response, lineage ? 200 : 404, lineage ? { requestId, items: lineage } : { error: { code: 'request_not_found' } });
        return true;
      }

      if (pathname === '/api/v1/stats') {
        if (!durable) { json(response, 503, { error: { code: 'durable_unavailable' } }); return true; }
        const filters: Pick<RequestFilters, 'fromMs' | 'toMs' | 'provider' | 'model'> = {};
        const fromMs = parseInteger(searchParams.get('from'), 'from');
        if (fromMs !== undefined) filters.fromMs = fromMs;
        const toMs = parseInteger(searchParams.get('to'), 'to');
        if (toMs !== undefined) filters.toMs = toMs;
        const selectedProvider = provider(searchParams.get('provider'));
        if (selectedProvider) filters.provider = selectedProvider;
        const model = searchParams.get('model');
        if (model) filters.model = model.slice(0, 256);
        json(response, 200, await durable.statistics(filters));
        return true;
      }

      if (pathname === '/api/v1/system') {
        const durableCounts = durable ? await durable.healthCounts() : null;
        const rawRetention = raw ? await raw.retentionStatus() : null;
        json(response, 200, {
          status: durable ? 'healthy' : 'degraded',
          durable: {
            available: durable !== null,
            ...dependencies.durableStatus(),
            ...durableCounts,
            ...(durable?.storageStats() ?? {}),
            databaseBytes: fileBytes(dependencies.config.durablePath),
            walBytes: fileBytes(`${dependencies.config.durablePath}-wal`),
          },
          raw: {
            enabled: dependencies.config.raw !== null,
            downloadEnabled: dependencies.config.rawDownloadEnabled,
            available: raw !== null,
            ...dependencies.rawStatus(),
            ...(raw?.stats() ?? {}),
            ...rawRetention,
            databaseBytes: dependencies.config.raw ? fileBytes(dependencies.config.raw.path) : 0,
            walBytes: dependencies.config.raw ? fileBytes(`${dependencies.config.raw.path}-wal`) : 0,
          },
          events: dependencies.events.stats(),
        });
        return true;
      }

      const rawMatch = pathname.match(/^\/api\/v1\/raw\/([A-Za-z0-9_-]{1,128})$/);
      if (rawMatch) {
        if (!dependencies.config.rawDownloadEnabled) return false;
        const requestId = safeId(rawMatch[1] ?? '');
        if (!durable) { json(response, 503, { error: { code: 'durable_unavailable' } }); return true; }
        const requestDetail = await durable.getRequest(requestId);
        if (!requestDetail) { json(response, 404, { error: { code: 'request_not_found' } }); return true; }
        if (!raw) { json(response, 503, { error: { code: 'raw_unavailable' } }); return true; }
        const manifest = await raw.manifest(requestId);
        if (!manifest) { json(response, 410, { error: { code: 'raw_expired' }, rawState: rawState(requestDetail.raw_capture_state, undefined, true) }); return true; }
        const direction = searchParams.get('direction');
        if (direction === 'request' || direction === 'response') {
          const complete = direction === 'request' ? manifest.request_complete === 1 : manifest.response_complete === 1;
          if (!complete) { json(response, 409, { error: { code: 'raw_incomplete' }, direction }); return true; }
          const body = await raw.reconstruct(requestId, direction);
          log.info({ requestId, direction, bytes: body.length }, 'raw capture downloaded');
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(body.length),
            'content-disposition': `attachment; filename="${requestId}-${direction}.bin"`,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
          response.end(body);
          return true;
        }
        json(response, 200, {
          ...manifest,
          request_sha256: manifest.request_sha256?.toString('hex') ?? null,
          response_sha256: manifest.response_sha256?.toString('hex') ?? null,
          raw_state: rawState(requestDetail.raw_capture_state, manifest.capture_state, true),
          retained_until_ms: dependencies.config.raw ? manifest.created_at_ms + dependencies.config.raw.retentionHours * 3_600_000 : null,
          downloads: {
            request: `/api/v1/raw/${requestId}?direction=request`,
            response: `/api/v1/raw/${requestId}?direction=response`,
          },
        });
        return true;
      }

      return false;
    } catch (error) {
      const code = error instanceof Error && /^invalid_|^too_many_/.test(error.message) ? error.message : 'admin_query_failed';
      json(response, code === 'admin_query_failed' ? 500 : 400, { error: { code } });
      return true;
    }
  };
}
