import * as http from 'node:http';
import * as https from 'node:https';
import type { OutgoingHttpHeaders } from 'node:http';
import type { RefractConfig } from '../config.js';
import { prepareRequestHeaders, sanitizeRawHeaders } from '../credentials/redact.js';
import type { RawCaptureStore } from '../storage/raw-store.js';
import type { DurableStore } from '../storage/durable-store.js';
import { ExchangeObservation } from '../providers/recording.js';
import { flattenHeaderPairs, stripHopByHopHeaders } from './headers.js';
import type { LifecycleTracker } from './lifecycle.js';
import { resolveRoute } from './router.js';

export interface Forwarder {
  handle(request: http.IncomingMessage, response: http.ServerResponse): void;
  drain(): Promise<void>;
  destroy(): void;
}

function sendLocalError(response: http.ServerResponse, status: number, code: string): void {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify({ error: { type: 'refract_transport_error', code } }));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function safeErrorCode(error: Error & { code?: string }): string {
  const code = error.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UPSTREAM_ERROR';
}

export function createForwarder(
  config: RefractConfig,
  lifecycle: LifecycleTracker,
  rawStore: () => RawCaptureStore | null = () => null,
  durableStore: () => DurableStore | null = () => null,
): Forwarder {
  const httpAgent = new http.Agent({ keepAlive: true });
  const httpsAgent = new https.Agent({ keepAlive: true });
  const observations = new Set<Promise<void>>();
  const track = (promise: Promise<void>) => {
    observations.add(promise);
    void promise.then(() => observations.delete(promise), () => observations.delete(promise));
  };

  return {
    handle(request, response) {
      const resolution = resolveRoute(request.method, request.url, config);
      if (resolution.kind === 'rejected') {
        request.resume();
        response.setHeader('connection', 'close');
        if (resolution.status === 405) response.setHeader('allow', 'POST');
        sendLocalError(response, resolution.status, resolution.code);
        return;
      }

      const { route } = resolution;
      const record = lifecycle.accept(route.provider, route.surface);
      const client = route.origin.protocol === 'https:' ? https : http;
      const authority = route.origin.host;
      const preparedHeaders = prepareRequestHeaders(request.rawHeaders, authority, config.credentials[route.provider], config.sensitiveHeaders);
      const rawHeaders = flattenHeaderPairs(preparedHeaders.upstream);
      const rawCapture = rawStore()?.begin({
        requestId: record.id,
        provider: route.provider,
        requestHeaders: preparedHeaders.observation,
        knownSecrets: preparedHeaders.knownSecrets,
        createdAtMs: record.acceptedAtMs,
      }) ?? null;
      const observation = new ExchangeObservation({
        request: {
          id: record.id,
          startedAtMs: record.acceptedAtMs,
          provider: route.provider,
          surface: route.surface,
          method: 'POST',
          pathAndQuery: route.pathAndQuery,
          streamingRequested: false,
        },
        surface: route.surface,
        knownSecrets: preparedHeaders.knownSecrets,
        maximumBodyBytes: config.parserMaxBodyBytes,
        durable: durableStore,
        raw: rawStore,
      });
      let responseStarted = false;
      let downstreamFinished = false;
      let upstreamResponse: http.IncomingMessage | null = null;

      const upstreamRequest = client.request({
        protocol: route.origin.protocol,
        hostname: route.origin.hostname,
        port: route.origin.port || undefined,
        method: 'POST',
        path: route.pathAndQuery,
        headers: rawHeaders as unknown as OutgoingHttpHeaders,
        agent: route.origin.protocol === 'https:' ? httpsAgent : httpAgent,
        setHost: false,
      }, (incoming) => {
        upstreamResponse = incoming;
        responseStarted = true;
        clearTimeout(headersTimer);
        const ttfbMs = lifecycle.elapsed(record.id) ?? 0;
        const status = incoming.statusCode ?? 502;
        lifecycle.transition(record.id, 'response_started', { httpStatus: status, ttfbMs });
        const responseHeaderPairs = stripHopByHopHeaders(incoming.rawHeaders);
        const outgoingHeaders = flattenHeaderPairs(responseHeaderPairs);
        rawCapture?.responseStarted(status, sanitizeRawHeaders(incoming.rawHeaders, preparedHeaders.knownSecrets, config.sensitiveHeaders));
        observation.responseStarted(status, responseHeaderPairs, ttfbMs);
        if (incoming.statusMessage) response.writeHead(status, incoming.statusMessage, outgoingHeaders);
        else response.writeHead(status, outgoingHeaders);

        incoming.on('data', (chunk: Buffer) => { rawCapture?.observe('response', chunk); observation.responseChunk(chunk); });
        incoming.once('end', () => rawCapture?.complete('response'));
        incoming.once('aborted', () => {
          rawCapture?.partial();
          track(observation.fail('upstream_stream_error', 'UPSTREAM_ABORTED', lifecycle.elapsed(record.id) ?? 0));
          if (!lifecycle.has(record.id)) return;
          lifecycle.transition(record.id, 'upstream_stream_error', {
            totalMs: lifecycle.elapsed(record.id) ?? 0,
            errorCode: 'UPSTREAM_ABORTED',
          });
          response.destroy();
        });
        incoming.once('error', (error: Error & { code?: string }) => {
          rawCapture?.partial();
          track(observation.fail('upstream_stream_error', safeErrorCode(error), lifecycle.elapsed(record.id) ?? 0));
          if (!lifecycle.has(record.id)) return;
          lifecycle.transition(record.id, 'upstream_stream_error', {
            totalMs: lifecycle.elapsed(record.id) ?? 0,
            errorCode: safeErrorCode(error),
          });
          response.destroy(error);
        });
        incoming.pipe(response);
      });

      request.on('data', (chunk: Buffer) => { rawCapture?.observe('request', chunk); observation.requestChunk(chunk); });
      request.once('end', () => rawCapture?.complete('request'));
      lifecycle.transition(record.id, 'upstream_started');
      const headersTimer = setTimeout(() => {
        const error = Object.assign(new Error('upstream headers timeout'), { code: 'UPSTREAM_HEADERS_TIMEOUT' });
        upstreamRequest.destroy(error);
      }, config.timeouts.upstreamHeadersMs);
      headersTimer.unref();

      upstreamRequest.setTimeout(config.timeouts.upstreamIdleMs, () => {
        const error = Object.assign(new Error('upstream idle timeout'), { code: 'UPSTREAM_IDLE_TIMEOUT' });
        upstreamRequest.destroy(error);
      });

      upstreamRequest.once('error', (error: Error & { code?: string }) => {
        clearTimeout(headersTimer);
        rawCapture?.partial();
        track(observation.fail(responseStarted ? 'upstream_stream_error' : 'upstream_connect_error', safeErrorCode(error), lifecycle.elapsed(record.id) ?? 0));
        if (!lifecycle.has(record.id)) return;
        const state = responseStarted ? 'upstream_stream_error' : 'upstream_connect_error';
        lifecycle.transition(record.id, state, {
          totalMs: lifecycle.elapsed(record.id) ?? 0,
          errorCode: safeErrorCode(error),
        });
        sendLocalError(response, 502, safeErrorCode(error));
      });

      request.once('aborted', () => {
        rawCapture?.partial();
        track(observation.fail('downstream_cancelled', 'REQUEST_ABORTED', lifecycle.elapsed(record.id) ?? 0));
        if (!lifecycle.has(record.id)) return;
        lifecycle.transition(record.id, 'downstream_cancelled', {
          totalMs: lifecycle.elapsed(record.id) ?? 0,
          errorCode: 'REQUEST_ABORTED',
        });
        upstreamRequest.destroy();
        upstreamResponse?.destroy();
      });

      response.once('finish', () => {
        downstreamFinished = true;
        const totalMs = lifecycle.elapsed(record.id) ?? 0;
        track(observation.complete(totalMs));
        if (!lifecycle.has(record.id)) return;
        lifecycle.transition(record.id, 'completed', { totalMs });
      });

      response.once('close', () => {
        if (downstreamFinished || !lifecycle.has(record.id)) return;
        rawCapture?.partial();
        track(observation.fail('downstream_cancelled', 'DOWNSTREAM_CLOSED', lifecycle.elapsed(record.id) ?? 0));
        lifecycle.transition(record.id, 'downstream_cancelled', {
          totalMs: lifecycle.elapsed(record.id) ?? 0,
          errorCode: 'DOWNSTREAM_CLOSED',
        });
        upstreamRequest.destroy();
        upstreamResponse?.destroy();
      });

      request.pipe(upstreamRequest);
    },
    async drain() {
      await Promise.allSettled([...observations]);
    },
    destroy() {
      httpAgent.destroy();
      httpsAgent.destroy();
    },
  };
}
