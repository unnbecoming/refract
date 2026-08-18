import type { ApiSurface, Provider } from '../config.js';
import type { HeaderPair } from '../proxy/headers.js';
import { SseDecoder } from './sse-decoder.js';
import { createProviderStreamParser, parseProviderRequest, parseProviderResponse } from './registry.js';
import type { ParsedProviderRequest, ParsedProviderResponse } from './types.js';
import type { CanonicalExchange, RequestMetadata } from '../storage/durable-store.js';
import type { DurableStore } from '../storage/durable-store.js';
import type { RawCaptureStore } from '../storage/raw-store.js';
import { scrubKnownSecrets } from '../credentials/redact.js';

class BoundedBody {
  readonly #maximum: number;
  readonly #chunks: Buffer[] = [];
  totalBytes = 0;
  overflow = false;

  constructor(maximum: number) { this.#maximum = maximum; }

  push(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    if (this.overflow) return;
    if (this.totalBytes > this.#maximum) {
      this.overflow = true;
      this.#chunks.length = 0;
      return;
    }
    this.#chunks.push(Buffer.from(chunk));
  }

  body(): Buffer {
    if (this.overflow) throw new Error('observer_body_limit');
    return Buffer.concat(this.#chunks);
  }
}

export interface ExchangeObservationInput {
  request: RequestMetadata;
  surface: ApiSurface;
  knownSecrets: Buffer[];
  maximumBodyBytes: number;
  durable: () => DurableStore | null;
  raw: () => RawCaptureStore | null;
  notify?: (type: string, data: Record<string, unknown>) => void;
}

interface CompletionInput {
  httpStatus: number;
  ttfbMs: number;
  totalMs: number;
  state?: string;
}

async function rawState(requestId: string, raw: RawCaptureStore | null): Promise<string> {
  if (!raw) return 'disabled';
  const row = await raw.getExchange(requestId);
  return row?.capture_state ?? 'unavailable';
}

function safeSurface(value: unknown): ApiSurface {
  if (value === 'messages' || value === 'chat_completions' || value === 'responses') return value;
  throw new Error('unsupported_api_surface');
}

function safeProvider(value: unknown): Provider {
  if (value === 'anthropic' || value === 'openai') return value;
  throw new Error('unsupported_provider');
}

function parseSse(surface: ApiSurface, body: Buffer): ParsedProviderResponse {
  const parser = createProviderStreamParser(surface);
  const decoder = new SseDecoder((event) => parser.push(event));
  decoder.push(body);
  decoder.finish();
  return parser.finish();
}

async function ancestry(durable: DurableStore, parsed: ParsedProviderRequest): Promise<{
  baseTailId: Buffer | null;
  parentRequestId?: string;
  lineageSource?: string;
}> {
  const reference = parsed.previousResponseId
    ? { type: 'response', id: parsed.previousResponseId, source: 'previous_response_id' }
    : parsed.providerConversationId
      ? { type: 'conversation', id: parsed.providerConversationId, source: 'provider_conversation' }
      : null;
  if (!reference) return { baseTailId: null };
  const found = await durable.resolveProviderObject(parsed.provider, reference.type, reference.id);
  if (!found) return { baseTailId: null, lineageSource: `unresolved_${reference.source}` };
  return { baseTailId: found.outputTailId, parentRequestId: found.requestId, lineageSource: reference.source };
}

async function persistParsed(input: {
  durable: DurableStore;
  request: RequestMetadata;
  requestParsed: ParsedProviderRequest;
  responseParsed: ParsedProviderResponse;
  completedAtMs: number;
  completion: CompletionInput;
  requestBytes: number;
  responseBytes: number;
  rawCaptureState: string;
  knownSecrets: Buffer[];
}): Promise<void> {
  const lineage = await ancestry(input.durable, input.requestParsed);
  const exchange: CanonicalExchange = {
    request: {
      ...input.request,
      pathAndQuery: scrubKnownSecrets(input.request.pathAndQuery, input.knownSecrets),
      streamingRequested: input.requestParsed.streaming,
    },
    completedAtMs: input.completedAtMs,
    state: input.completion.state ?? 'completed',
    httpStatus: input.completion.httpStatus,
    ttfbMs: input.completion.ttfbMs,
    totalMs: input.completion.totalMs,
    requestBytes: input.requestBytes,
    responseBytes: input.responseBytes,
    baseTailId: lineage.baseTailId,
    input: input.requestParsed.items.map((item) => ({ item, providerType: item.kind })),
    output: input.responseParsed.items.map((item) => ({ item, providerType: item.kind })),
    rawCaptureState: input.rawCaptureState,
    knownSecrets: input.knownSecrets,
  };
  if (input.requestParsed.model) exchange.modelRequested = input.requestParsed.model;
  if (input.responseParsed.model) exchange.modelResolved = input.responseParsed.model;
  if (input.responseParsed.usage) exchange.usage = input.responseParsed.usage;
  if (lineage.parentRequestId) exchange.parentRequestId = lineage.parentRequestId;
  if (lineage.lineageSource) exchange.lineageSource = lineage.lineageSource;
  if (input.responseParsed.providerResponseId) exchange.providerResponseId = input.responseParsed.providerResponseId;
  if (input.requestParsed.previousResponseId) exchange.previousResponseId = input.requestParsed.previousResponseId;
  const providerConversationId = input.responseParsed.providerConversationId ?? input.requestParsed.providerConversationId;
  if (providerConversationId) exchange.providerConversationId = providerConversationId;
  await input.durable.recordCanonicalExchange(exchange);
}

export class ExchangeObservation {
  readonly #input: ExchangeObservationInput;
  readonly #requestBody: BoundedBody;
  readonly #responseBody: BoundedBody;
  #streamParser: ReturnType<typeof createProviderStreamParser> | null = null;
  #sseDecoder: SseDecoder | null = null;
  #parseFailed = false;
  #finished = false;
  #status = 0;
  #ttfbMs = 0;

  constructor(input: ExchangeObservationInput) {
    this.#input = input;
    this.#requestBody = new BoundedBody(input.maximumBodyBytes);
    this.#responseBody = new BoundedBody(input.maximumBodyBytes);
    const durable = input.durable();
    if (durable) {
      const safeRequest = { ...input.request, pathAndQuery: scrubKnownSecrets(input.request.pathAndQuery, input.knownSecrets) };
      void durable.acceptRequest(safeRequest).catch(() => undefined);
    }
  }

  requestChunk(chunk: Buffer): void { this.#requestBody.push(chunk); }

  responseStarted(status: number, headers: readonly HeaderPair[], ttfbMs: number): void {
    this.#status = status;
    this.#ttfbMs = ttfbMs;
    const contentType = headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1].toLowerCase() ?? '';
    if (contentType.includes('text/event-stream')) {
      this.#streamParser = createProviderStreamParser(this.#input.surface);
      this.#sseDecoder = new SseDecoder((event) => this.#streamParser?.push(event));
    }
  }

  responseChunk(chunk: Buffer): void {
    this.#responseBody.push(chunk);
    if (this.#responseBody.overflow || !this.#sseDecoder || this.#parseFailed) return;
    try { this.#sseDecoder.push(chunk); }
    catch { this.#parseFailed = true; }
  }

  complete(totalMs: number): Promise<void> {
    if (this.#finished) return Promise.resolve();
    this.#finished = true;
    return this.#finalize(totalMs);
  }

  fail(state: string, errorCode: string, totalMs: number): Promise<void> {
    if (this.#finished) return Promise.resolve();
    this.#finished = true;
    const durable = this.#input.durable();
    if (!durable) return Promise.resolve();
    return rawState(this.#input.request.id, this.#input.raw()).then((captureState) => {
      const failure: Parameters<DurableStore['markParseFailure']>[0] = {
        requestId: this.#input.request.id,
        completedAtMs: Date.now(),
        state,
        errorCode,
        errorMessage: 'transport ended before canonical observation completed',
        totalMs,
        requestBytes: this.#requestBody.totalBytes,
        responseBytes: this.#responseBody.totalBytes,
        rawCaptureState: captureState,
      };
      if (this.#status) failure.httpStatus = this.#status;
      if (this.#ttfbMs) failure.ttfbMs = this.#ttfbMs;
      return durable.markParseFailure(failure).then(() => this.#input.notify?.('canonical_failed', { requestId: this.#input.request.id, errorCode }));
    }).catch(() => undefined);
  }

  async #finalize(totalMs: number): Promise<void> {
    const durable = this.#input.durable();
    if (!durable) return;
    try {
      if (this.#requestBody.overflow || this.#responseBody.overflow) throw new Error('observer_body_limit');
      const requestParsed = parseProviderRequest(this.#input.surface, this.#requestBody.body());
      let responseParsed: ParsedProviderResponse;
      if (this.#sseDecoder && this.#streamParser) {
        if (this.#parseFailed) throw new Error('invalid_sse');
        this.#sseDecoder.finish();
        responseParsed = this.#streamParser.finish();
      } else responseParsed = parseProviderResponse(this.#input.surface, this.#responseBody.body());
      const captureState = await rawState(this.#input.request.id, this.#input.raw());
      await persistParsed({
        durable,
        request: this.#input.request,
        requestParsed,
        responseParsed,
        completedAtMs: Date.now(),
        completion: { httpStatus: this.#status, ttfbMs: this.#ttfbMs, totalMs },
        requestBytes: this.#requestBody.totalBytes,
        responseBytes: this.#responseBody.totalBytes,
        rawCaptureState: captureState,
        knownSecrets: this.#input.knownSecrets,
      });
      this.#input.notify?.('canonical_completed', { requestId: this.#input.request.id });
    } catch (error) {
      const code = error instanceof Error && error.message === 'observer_body_limit' ? 'body_limit' : 'adapter_parse_failed';
      const captureState = await rawState(this.#input.request.id, this.#input.raw()).catch(() => 'unavailable');
      await durable.markParseFailure({
        requestId: this.#input.request.id,
        completedAtMs: Date.now(),
        state: 'completed',
        httpStatus: this.#status,
        errorCode: code,
        errorMessage: code === 'body_limit' ? 'observer body exceeded configured limit' : 'provider payload could not be canonicalized',
        ttfbMs: this.#ttfbMs,
        totalMs,
        requestBytes: this.#requestBody.totalBytes,
        responseBytes: this.#responseBody.totalBytes,
        rawCaptureState: captureState,
      }).then(() => this.#input.notify?.('canonical_failed', { requestId: this.#input.request.id, errorCode: code })).catch(() => undefined);
    }
  }
}

export async function replayRetainedRaw(input: {
  requestId: string;
  durable: DurableStore;
  raw: RawCaptureStore;
  maximumBodyBytes: number;
  knownSecrets: Buffer[];
}): Promise<void> {
  const row = await input.durable.getRequest(input.requestId);
  if (!row) throw new Error('request_not_found');
  const rawRow = await input.raw.getExchange(input.requestId);
  if (!rawRow || rawRow.capture_state !== 'complete' || rawRow.request_complete !== 1 || rawRow.response_complete !== 1) throw new Error('raw_capture_not_complete');
  if (rawRow.request_bytes > input.maximumBodyBytes || rawRow.response_bytes > input.maximumBodyBytes) throw new Error('observer_body_limit');
  const surface = safeSurface(row.api_surface);
  const provider = safeProvider(row.provider);
  const requestBytes = await input.raw.reconstruct(input.requestId, 'request');
  const responseBytes = await input.raw.reconstruct(input.requestId, 'response');
  const requestParsed = parseProviderRequest(surface, requestBytes);
  const trimmed = responseBytes.subarray(0, Math.min(responseBytes.length, 64)).toString('utf8').trimStart();
  const responseParsed = requestParsed.streaming && !trimmed.startsWith('{') ? parseSse(surface, responseBytes) : parseProviderResponse(surface, responseBytes);
  const request: RequestMetadata = {
    id: input.requestId,
    startedAtMs: typeof row.started_at_ms === 'number' ? row.started_at_ms : Date.now(),
    provider,
    surface,
    method: typeof row.method === 'string' ? row.method : 'POST',
    pathAndQuery: typeof row.path_and_query === 'string' ? row.path_and_query : '',
    streamingRequested: requestParsed.streaming,
  };
  await persistParsed({
    durable: input.durable,
    request,
    requestParsed,
    responseParsed,
    completedAtMs: Date.now(),
    completion: {
      httpStatus: rawRow.response_status ?? (typeof row.http_status === 'number' ? row.http_status : 200),
      ttfbMs: typeof row.ttfb_ms === 'number' ? row.ttfb_ms : 0,
      totalMs: typeof row.total_ms === 'number' ? row.total_ms : 0,
      state: typeof row.state === 'string' ? row.state : 'completed',
    },
    requestBytes: requestBytes.length,
    responseBytes: responseBytes.length,
    rawCaptureState: rawRow.capture_state,
    knownSecrets: input.knownSecrets,
  });
}
