import * as http from 'node:http';
import * as https from 'node:https';
import type { OutgoingHttpHeaders } from 'node:http';
import type { RefractConfig } from '../config.js';
import { prepareRequestHeaders, sanitizeRawHeaders } from '../credentials/redact.js';
import type { RawCaptureStore } from '../storage/raw-store.js';
import { flattenHeaderPairs, stripHopByHopHeaders } from './headers.js';
import type { LifecycleTracker } from './lifecycle.js';
import { resolveRoute } from './router.js';

export interface Forwarder {
  handle(request: http.IncomingMessage, response: http.ServerResponse): void;
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

export function createForwarder(config: RefractConfig, lifecycle: LifecycleTracker, rawStore: () => RawCaptureStore | null = () => null): Forwarder {
  const httpAgent = new http.Agent({ keepAlive: true });
  const httpsAgent = new https.Agent({ keepAlive: true });

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
        const outgoingHeaders = flattenHeaderPairs(stripHopByHopHeaders(incoming.rawHeaders));
        rawCapture?.responseStarted(status, sanitizeRawHeaders(incoming.rawHeaders, preparedHeaders.knownSecrets, config.sensitiveHeaders));
        if (incoming.statusMessage) response.writeHead(status, incoming.statusMessage, outgoingHeaders);
        else response.writeHead(status, outgoingHeaders);

        incoming.on('data', (chunk: Buffer) => rawCapture?.observe('response', chunk));
        incoming.once('end', () => rawCapture?.complete('response'));
        incoming.once('aborted', () => {
          rawCapture?.partial();
          if (!lifecycle.has(record.id)) return;
          lifecycle.transition(record.id, 'upstream_stream_error', {
            totalMs: lifecycle.elapsed(record.id) ?? 0,
            errorCode: 'UPSTREAM_ABORTED',
          });
          response.destroy();
        });
        incoming.once('error', (error: Error & { code?: string }) => {
          rawCapture?.partial();
          if (!lifecycle.has(record.id)) return;
          lifecycle.transition(record.id, 'upstream_stream_error', {
            totalMs: lifecycle.elapsed(record.id) ?? 0,
            errorCode: safeErrorCode(error),
          });
          response.destroy(error);
        });
        incoming.pipe(response);
      });

      request.on('data', (chunk: Buffer) => rawCapture?.observe('request', chunk));
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
        if (!lifecycle.has(record.id)) return;
        lifecycle.transition(record.id, 'completed', { totalMs: lifecycle.elapsed(record.id) ?? 0 });
      });

      response.once('close', () => {
        if (downstreamFinished || !lifecycle.has(record.id)) return;
        rawCapture?.partial();
        lifecycle.transition(record.id, 'downstream_cancelled', {
          totalMs: lifecycle.elapsed(record.id) ?? 0,
          errorCode: 'DOWNSTREAM_CLOSED',
        });
        upstreamRequest.destroy();
        upstreamResponse?.destroy();
      });

      request.pipe(upstreamRequest);
    },
    destroy() {
      httpAgent.destroy();
      httpsAgent.destroy();
    },
  };
}
