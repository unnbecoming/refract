import * as fs from 'node:fs';
import type { RefractConfig } from './config.js';
import type { LifecycleTracker } from './proxy/lifecycle.js';
import type { DurableStore } from './storage/durable-store.js';
import type { RawCaptureStore } from './storage/raw-store.js';
import type { LiveEventHub } from './api-events.js';

function fileBytes(filename: string): number { try { return fs.statSync(filename).size; } catch { return 0; } }
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
function labels(values: Record<string, unknown>): string {
  return `{${Object.entries(values).map(([key, value]) => `${key}="${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`;
}

export async function renderMetrics(input: {
  config: RefractConfig;
  lifecycle: LifecycleTracker;
  durable: DurableStore | null;
  raw: RawCaptureStore | null;
  events: LiveEventHub;
}): Promise<string> {
  const lines: string[] = [];
  const metric = (name: string, help: string, type: 'counter' | 'gauge' | 'histogram') => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  };
  const snapshot = input.durable ? await input.durable.metricsSnapshot() : null;
  const totals = (snapshot?.totals ?? {}) as Record<string, unknown>;
  metric('refract_requests_total', 'Durable requests by bounded transport dimensions.', 'counter');
  for (const group of (snapshot?.groups ?? []) as Array<Record<string, unknown>>) {
    lines.push(`refract_requests_total${labels({ provider: group.provider, surface: group.surface, state: group.state, status_class: group.status_class })} ${number(group.requests)}`);
  }
  metric('refract_active_requests', 'Currently active transport requests.', 'gauge');
  lines.push(`refract_active_requests ${input.lifecycle.snapshot().active.length}`);
  for (const [name, key] of [
    ['refract_request_bytes_total', 'request_bytes'], ['refract_response_bytes_total', 'response_bytes'],
    ['refract_input_tokens_total', 'input_tokens'], ['refract_output_tokens_total', 'output_tokens'],
    ['refract_cached_input_tokens_total', 'cached_input_tokens'], ['refract_cache_write_tokens_total', 'cache_write_tokens'],
    ['refract_reasoning_tokens_total', 'reasoning_tokens'], ['refract_parser_failures_total', 'parser_failures'],
  ] as const) {
    metric(name, `Durable ${key.replaceAll('_', ' ')}.`, 'counter');
    lines.push(`${name} ${number(totals[key])}`);
  }
  const boundaries = (snapshot?.boundaries ?? []) as number[];
  for (const [name, bucketKey, sumKey, countKey, help] of [
    ['refract_request_duration_milliseconds', 'durationBuckets', 'duration_sum_ms', 'duration_count', 'Completed request duration in milliseconds.'],
    ['refract_ttfb_milliseconds', 'ttfbBuckets', 'ttfb_sum_ms', 'ttfb_count', 'Upstream time to first byte in milliseconds.'],
  ] as const) {
    metric(name, help, 'histogram');
    const buckets = (snapshot?.[bucketKey] ?? {}) as Record<string, number>;
    for (const boundary of boundaries) lines.push(`${name}_bucket{le="${boundary}"} ${number(buckets[String(boundary)])}`);
    lines.push(`${name}_bucket{le="+Inf"} ${number(totals[countKey])}`);
    lines.push(`${name}_sum ${number(totals[sumKey])}`, `${name}_count ${number(totals[countKey])}`);
  }
  metric('refract_unknown_canonical_items_total', 'Unknown canonical items retained for future adapters.', 'counter');
  lines.push(`refract_unknown_canonical_items_total ${number(snapshot?.unknownItems)}`);
  const parserFailures = (snapshot?.parserFailures ?? []) as Array<Record<string, unknown>>;
  metric('refract_parser_failures_by_adapter_total', 'Parser failures by bounded provider, surface, and fixed error code.', 'counter');
  for (const failure of parserFailures) lines.push(`refract_parser_failures_by_adapter_total${labels({ provider: failure.provider, surface: failure.surface, error_code: failure.error_code })} ${number(failure.failures)}`);
  const durableStats = input.durable?.storageStats();
  metric('refract_durable_pending_writes', 'Durable writes waiting in the serialized queue.', 'gauge');
  lines.push(`refract_durable_pending_writes ${durableStats?.pendingWrites ?? 0}`);
  metric('refract_durable_write_failures_total', 'Durable write failures.', 'counter');
  lines.push(`refract_durable_write_failures_total ${durableStats?.writeFailures ?? 0}`);
  const rawStats = input.raw?.stats();
  metric('refract_raw_pending_writes', 'Raw capture writes waiting off the transport path.', 'gauge');
  lines.push(`refract_raw_pending_writes ${rawStats?.pendingWrites ?? 0}`);
  metric('refract_raw_write_failures_total', 'Raw capture write failures.', 'counter');
  lines.push(`refract_raw_write_failures_total ${rawStats?.writeFailures ?? 0}`);
  metric('refract_raw_capture_drops_total', 'Raw captures dropped by bounded reason.', 'counter');
  for (const [reason, count] of Object.entries(rawStats?.drops ?? {})) lines.push(`refract_raw_capture_drops_total${labels({ reason })} ${count}`);
  metric('refract_raw_pruned_total', 'Raw captures removed by retention or emergency pressure.', 'counter');
  lines.push(`refract_raw_pruned_total{reason="age"} ${rawStats?.agePruned ?? 0}`);
  lines.push(`refract_raw_pruned_total{reason="emergency"} ${rawStats?.emergencyPruned ?? 0}`);
  const retention = input.raw ? await input.raw.retentionStatus() : null;
  metric('refract_raw_retained', 'Raw exchanges currently retained.', 'gauge');
  lines.push(`refract_raw_retained ${number(retention?.retained)}`);
  metric('refract_database_bytes', 'SQLite database and WAL file bytes.', 'gauge');
  lines.push(`refract_database_bytes${labels({ store: 'durable', file: 'db' })} ${fileBytes(input.config.durablePath)}`);
  lines.push(`refract_database_bytes${labels({ store: 'durable', file: 'wal' })} ${fileBytes(`${input.config.durablePath}-wal`)}`);
  if (input.config.raw) {
    lines.push(`refract_database_bytes${labels({ store: 'raw', file: 'db' })} ${fileBytes(input.config.raw.path)}`);
    lines.push(`refract_database_bytes${labels({ store: 'raw', file: 'wal' })} ${fileBytes(`${input.config.raw.path}-wal`)}`);
  }
  const eventStats = input.events.stats();
  metric('refract_live_event_clients', 'Connected live event clients.', 'gauge');
  lines.push(`refract_live_event_clients ${eventStats.clients}`);
  metric('refract_live_event_drops_total', 'Live event clients dropped after backpressure.', 'counter');
  lines.push(`refract_live_event_drops_total ${eventStats.dropped}`);
  return `${lines.join('\n')}\n`;
}
