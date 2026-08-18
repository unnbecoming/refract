import { useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useParams, useSearchParams } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import ReactMarkdown from 'react-markdown';
import { ApiProvider } from './api.js';
import { useApi, useApiQuery } from './api-hooks.js';

type Json = undefined | null | boolean | number | string | Json[] | { [key: string]: Json };
interface RequestPage { items: Array<Record<string, Json>>; nextCursor: string | null }
interface Transcript { requestId?: string; tailId: string | null; items: Array<Record<string, Json>> }

function display(value: Json): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return `${value}`;
}
function formatTime(value: Json): string {
  return typeof value === 'number' ? new Date(value).toLocaleString() : '—';
}
function formatNumber(value: Json): string { return typeof value === 'number' ? new Intl.NumberFormat().format(value) : '—'; }
function formatDuration(value: Json): string { return typeof value === 'number' ? `${value.toFixed(1)} ms` : '—'; }
function stateTone(value: Json): string { return typeof value === 'string' ? `state state-${value.replaceAll('_', '-')}` : 'state'; }

function AuthPrompt() {
  const api = useApi();
  const [value, setValue] = useState('');
  if (!api.authRequired) return null;
  const submit = (event: FormEvent) => { event.preventDefault(); api.setToken(value); setValue(''); };
  return <div className="auth-backdrop" role="dialog" aria-modal="true" aria-labelledby="auth-title">
    <form className="auth-dialog" onSubmit={submit}>
      <p className="eyebrow">Admin boundary</p><h2 id="auth-title">Bearer token required</h2>
      <p>Held only in this tab’s memory. It is never written to browser storage.</p>
      <label>Token<input type="password" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} /></label>
      <button type="submit">Unlock workspace</button>
    </form>
  </div>;
}

function QueryState({ loading, error, empty, children }: { loading: boolean; error: string | null; empty: boolean; children: ReactNode }) {
  if (loading) return <div className="query-state" role="status">Loading…</div>;
  if (error) return <div className="query-state error" role="alert">{error}</div>;
  if (empty) return <div className="query-state">No matching records.</div>;
  return <>{children}</>;
}

function Layout() {
  const api = useApi();
  return <div className="shell">
    <header className="topbar"><NavLink className="brand" to="/"><span className="brand-mark">R</span><span>Refract</span></NavLink><span className={`connection connection-${api.eventState}`}><span />{api.eventState}</span></header>
    <nav className="sidebar" aria-label="Primary navigation">
      <NavLink to="/" end>Activity</NavLink><NavLink to="/requests">Requests</NavLink><NavLink to="/stats">Statistics</NavLink><NavLink to="/system">System</NavLink>
    </nav>
    <main className="workspace"><Routes>
      <Route path="/" element={<Activity />} />
      <Route path="/requests" element={<RequestBrowser />} />
      <Route path="/requests/:id" element={<RequestDetail />} />
      <Route path="/stats" element={<Statistics />} />
      <Route path="/system" element={<SystemStatus />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes></main>
    <AuthPrompt />
  </div>;
}

function Activity() {
  const query = useApiQuery<{ active: Array<Record<string, Json>>; recent: Array<Record<string, Json>>; durable: Record<string, Json>; raw: Record<string, Json> }>('/api/v1/transport');
  const active = query.data?.active ?? [], recent = query.data?.recent ?? [];
  return <section><PageHeader eyebrow="Live activity" title="Recorder traffic" subtitle="Transport events are hints; every view re-reads durable state." />
    <QueryState loading={query.loading} error={query.error} empty={!query.data}>
      <div className="summary-strip"><Metric label="Active" value={active.length} /><Metric label="Recent" value={recent.length} /><Metric label="Durable" value={query.data?.durable.available ? 'online' : 'degraded'} /><Metric label="Raw" value={query.data?.raw.available ? 'online' : query.data?.raw.enabled ? 'degraded' : 'disabled'} /></div>
      <h2>Active requests</h2>{active.length === 0 ? <p className="muted">No requests in flight.</p> : <RequestTable items={active} />}
      <h2>Recent completion</h2>{recent.length === 0 ? <p className="muted">No recent traffic.</p> : <RequestTable items={recent.slice(0, 20)} />}
    </QueryState>
  </section>;
}

function PageHeader({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) {
  return <header className="page-header"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{subtitle}</p></header>;
}
function Metric({ label, value }: { label: string; value: ReactNode }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }

function RequestTable({ items }: { items: Array<Record<string, Json>> }) {
  return <div className="table-wrap"><table><thead><tr><th>Started</th><th>Provider / surface</th><th>Model</th><th>Status</th><th>Latency</th><th>Raw</th></tr></thead><tbody>{items.map((item) => <tr key={display(item.id)}>
    <td><NavLink to={`/requests/${display(item.id)}`}>{formatTime(item.started_at_ms ?? item.acceptedAtMs)}</NavLink></td>
    <td>{display(item.provider)}<small>{display(item.api_surface ?? item.surface)}</small></td><td>{display(item.model_resolved ?? item.model_requested ?? '—')}</td>
    <td><span className={stateTone(item.state)}>{display(item.state)}</span>{item.http_status ? <small>HTTP {display(item.http_status)}</small> : null}</td><td>{formatDuration(item.total_ms ?? item.totalMs)}</td><td>{display(item.raw_state ?? item.raw_capture_state ?? '—')}</td>
  </tr>)}</tbody></table></div>;
}

function RequestBrowser() {
  const [params, setParams] = useSearchParams();
  const queryString = params.toString();
  const query = useApiQuery<RequestPage>(`/api/v1/requests?limit=100${queryString ? `&${queryString}` : ''}`);
  const parent = useRef<HTMLDivElement>(null);
  const rows = query.data?.items ?? [];
  // TanStack Virtual returns intentionally non-memoizable callbacks; React Compiler must leave this hook alone.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parent.current, estimateSize: () => 66, overscan: 8, initialRect: { width: 900, height: 600 } });
  const update = (key: string, value: string) => { const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); next.delete('cursor'); setParams(next); };
  return <section><PageHeader eyebrow="Durable index" title="Requests" subtitle="Cursor-bounded records remain useful after raw capture expires." />
    <div className="filters" aria-label="Request filters">
      <label>Provider<select value={params.get('provider') ?? ''} onChange={(event) => update('provider', event.target.value)}><option value="">All</option><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option></select></label>
      <label>Surface<select value={params.get('surface') ?? ''} onChange={(event) => update('surface', event.target.value)}><option value="">All</option><option value="messages">Messages</option><option value="chat_completions">Chat</option><option value="responses">Responses</option></select></label>
      <label>State<input value={params.get('state') ?? ''} onChange={(event) => update('state', event.target.value)} placeholder="completed" /></label>
      <label>Parser<select value={params.get('parse_status') ?? ''} onChange={(event) => update('parse_status', event.target.value)}><option value="">All</option><option value="parsed">Parsed</option><option value="failed">Failed</option><option value="pending">Pending</option></select></label>
      <label>Raw<select value={params.get('raw_state') ?? ''} onChange={(event) => update('raw_state', event.target.value)}><option value="">All</option><option value="complete">Recorded</option><option value="partial">Partial</option><option value="dropped_secret">Secret drop</option></select></label>
      <label>Model<input value={params.get('model') ?? ''} onChange={(event) => update('model', event.target.value)} placeholder="exact model" /></label>
    </div>
    <QueryState loading={query.loading} error={query.error} empty={rows.length === 0}>
      <div className="virtual-list" ref={parent} role="list" aria-label="Requests"><div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>{virtualizer.getVirtualItems().map((virtual) => {
        const item = rows[virtual.index]!;
        return <div role="listitem" className="request-row" key={display(item.id)} style={{ transform: `translateY(${virtual.start}px)` }}><NavLink className="request-link" to={`/requests/${display(item.id)}`}>
          <span className="request-time">{formatTime(item.started_at_ms)}</span><span><strong>{display(item.provider)}</strong><small>{display(item.api_surface)}</small></span><span className="request-model">{display(item.model_resolved ?? item.model_requested ?? 'unknown model')}</span><span className={stateTone(item.state)}>{display(item.state)}</span><span>{formatDuration(item.total_ms)}</span><span className="raw-state">{display(item.raw_state)}</span>
        </NavLink></div>;
      })}</div></div>
      <div className="pagination"><button disabled={!query.data?.nextCursor} onClick={() => query.data?.nextCursor && setParams((current) => { const next = new URLSearchParams(current); next.set('cursor', query.data!.nextCursor!); return next; })}>Next page</button>{params.has('cursor') ? <button onClick={() => setParams((current) => { const next = new URLSearchParams(current); next.delete('cursor'); return next; })}>First page</button> : null}</div>
    </QueryState>
  </section>;
}

function RequestDetail() {
  const { id = '' } = useParams();
  const [tab, setTab] = useState<'transcript' | 'overview' | 'raw'>('transcript');
  const detail = useApiQuery<Record<string, Json>>(`/api/v1/requests/${encodeURIComponent(id)}`);
  const transcript = useApiQuery<Transcript>(`/api/v1/requests/${encodeURIComponent(id)}/transcript`);
  const lineage = useApiQuery<{ items: Array<Record<string, Json>> }>(`/api/v1/lineages/${encodeURIComponent(id)}`);
  const tabs = ['transcript', 'overview', 'raw'] as const;
  const moveTab = (key: string) => {
    const index = tabs.indexOf(tab);
    const next = key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : key === 'ArrowLeft' ? tabs[(index + tabs.length - 1) % tabs.length] : null;
    if (next) { setTab(next); document.getElementById(`tab-${next}`)?.focus(); }
  };
  return <section><div className="detail-heading"><div><p className="eyebrow">Request inspector</p><h1>{id}</h1></div><NavLink to="/requests">← All requests</NavLink></div>
    <div className="tabs" role="tablist" aria-label="Request views">{tabs.map((name) => <button key={name} id={`tab-${name}`} role="tab" aria-selected={tab === name} aria-controls={`panel-${name}`} tabIndex={tab === name ? 0 : -1} onKeyDown={(event) => moveTab(event.key)} onClick={() => setTab(name)}>{name === 'raw' ? 'Raw opt-in' : name[0]!.toUpperCase() + name.slice(1)}</button>)}</div>
    <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
      {tab === 'transcript' ? <QueryState loading={transcript.loading} error={transcript.error} empty={!transcript.data?.items.length}><TranscriptView items={transcript.data?.items ?? []} /></QueryState> : null}
      {tab === 'overview' ? <QueryState loading={detail.loading || lineage.loading} error={detail.error ?? lineage.error} empty={!detail.data}><Overview detail={detail.data ?? {}} lineage={lineage.data?.items ?? []} /></QueryState> : null}
      {tab === 'raw' ? <RawInspector requestId={id} state={detail.data?.raw_state} /> : null}
    </div>
  </section>;
}

function TranscriptView({ items }: { items: Array<Record<string, Json>> }) {
  const [reasoning, setReasoning] = useState(false);
  const visible = useMemo(() => reasoning ? items : items.filter((item) => item.kind !== 'reasoning'), [items, reasoning]);
  return <div><label className="toggle"><input type="checkbox" checked={reasoning} onChange={(event) => setReasoning(event.target.checked)} /> Show reasoning</label>
    {visible.length > 100 ? <VirtualTranscript items={visible} /> : <div className="transcript transcript-short">{visible.map((item, index) => <CanonicalItem item={item} key={`${display(item.kind)}-${index}`} />)}</div>}
  </div>;
}

function VirtualTranscript({ items }: { items: Array<Record<string, Json>> }) {
  const parent = useRef<HTMLDivElement>(null);
  // TanStack Virtual returns intentionally non-memoizable callbacks; React Compiler must leave this hook alone.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({ count: items.length, getScrollElement: () => parent.current, estimateSize: () => 150, overscan: 5, initialRect: { width: 900, height: 600 }, measureElement: (element) => element.getBoundingClientRect().height });
  return <div className="transcript" ref={parent}><div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>{virtualizer.getVirtualItems().map((virtual) => <div className="transcript-slot" data-index={virtual.index} ref={virtualizer.measureElement} key={virtual.key} style={{ transform: `translateY(${virtual.start}px)` }}><CanonicalItem item={items[virtual.index]!} /></div>)}</div></div>;
}

function CanonicalItem({ item }: { item: Record<string, Json> }) {
  const kind = display(item.kind ?? 'unknown');
  if (kind === 'message') return <article className={`turn role-${display(item.role)}`}><header><span>{display(item.role)}</span></header><Parts parts={Array.isArray(item.content) ? item.content : []} /></article>;
  if (kind === 'tool_call') return <article className="turn tool"><header>Tool call · {display(item.name ?? 'unknown')}</header><pre>{JSON.stringify(item.arguments, null, 2)}</pre></article>;
  if (kind === 'tool_result') return <article className="turn tool-result"><header>Tool result · {display(item.toolCallId ?? 'unlinked')}</header><Parts parts={Array.isArray(item.content) ? item.content : []} /></article>;
  if (kind === 'reasoning') return <article className="turn reasoning"><header>Reasoning</header><Parts parts={Array.isArray(item.content) ? item.content : []} /></article>;
  if (kind === 'compaction') return <article className="turn compaction"><header>Compaction</header><pre>{JSON.stringify(item, null, 2)}</pre></article>;
  return <details className="turn unknown"><summary>Unknown canonical item · {display(item.providerType ?? kind)}</summary><pre>{JSON.stringify(item, null, 2)}</pre></details>;
}

function Parts({ parts }: { parts: Json[] }) {
  return <div className="parts">{parts.map((part, index) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return <pre key={index}>{JSON.stringify(part, null, 2)}</pre>;
    if (part.type === 'text') return <ReactMarkdown key={index} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener">{children}</a> }}>{display(part.text ?? '')}</ReactMarkdown>;
    if (part.type === 'media') return <p key={index} className="reference">Media · {display(part.mediaType ?? 'unknown')} · {display(part.sourceType ?? 'source')}</p>;
    if (part.type === 'reference') return <p key={index} className="reference">Reference · {display(part.uri ?? part.id ?? 'unknown')}</p>;
    return <details key={index}><summary>{display(part.type ?? 'structured part')}</summary><pre>{JSON.stringify(part, null, 2)}</pre></details>;
  })}</div>;
}

function Overview({ detail, lineage }: { detail: Record<string, Json>; lineage: Array<Record<string, Json>> }) {
  const fields: Array<[string, Json]> = [['Provider', detail.provider], ['Surface', detail.api_surface], ['State', detail.state], ['HTTP', detail.http_status], ['Model requested', detail.model_requested], ['Model resolved', detail.model_resolved], ['TTFB', detail.ttfb_ms], ['Total', detail.total_ms], ['Input tokens', detail.input_tokens], ['Output tokens', detail.output_tokens], ['Parser', detail.parse_status], ['Parser error', detail.parse_error_code], ['Raw', detail.raw_state], ['Provider response', detail.provider_response_id], ['Previous response', detail.previous_response_id], ['Input tail', detail.input_tail_id], ['Output tail', detail.output_tail_id]];
  return <div className="inspector-grid"><section className="panel"><h2>Request</h2><dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{label === 'TTFB' || label === 'Total' ? formatDuration(value) : display(value ?? '—')}</dd></div>)}</dl></section><section className="panel"><h2>Lineage</h2>{lineage.map((row) => <NavLink className="lineage-row" key={display(row.id)} to={`/requests/${display(row.id)}`}><span>{display(row.id)}</span><small>{display(row.lineage_source ?? 'root')}</small></NavLink>)}</section><section className="panel wide"><h2>Canonical occurrences</h2><pre>{JSON.stringify(detail.occurrences ?? [], null, 2)}</pre></section></div>;
}

function RawInspector({ requestId, state }: { requestId: string; state: Json }) {
  const api = useApi();
  const [enabled, setEnabled] = useState(false);
  const manifest = useApiQuery<Record<string, Json>>(enabled ? `/api/v1/raw/${encodeURIComponent(requestId)}` : null);
  const save = async (direction: 'request' | 'response') => {
    const blob = await api.download(`/api/v1/raw/${encodeURIComponent(requestId)}?direction=${direction}`);
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${requestId}-${direction}.bin`; anchor.click(); URL.revokeObjectURL(url);
  };
  if (!enabled) return <div className="raw-consent"><h2>Raw capture is separate sensitive data</h2><p>State: <strong>{display(state ?? 'unknown')}</strong>. Opening this view reads short-retention headers and enables exact body downloads. Raw data never enters transcripts or browser storage.</p><button onClick={() => setEnabled(true)}>Open raw inspector</button></div>;
  return <QueryState loading={manifest.loading} error={manifest.error} empty={!manifest.data}><div className="inspector-grid"><section className="panel"><h2>Retention</h2><dl><div><dt>State</dt><dd>{display(manifest.data?.raw_state)}</dd></div><div><dt>Retained until</dt><dd>{formatTime(manifest.data?.retained_until_ms ?? null)}</dd></div><div><dt>Request bytes</dt><dd>{formatNumber(manifest.data?.request_bytes ?? null)}</dd></div><div><dt>Response bytes</dt><dd>{formatNumber(manifest.data?.response_bytes ?? null)}</dd></div><div><dt>Request SHA-256</dt><dd className="mono">{display(manifest.data?.request_sha256 ?? '—')}</dd></div><div><dt>Response SHA-256</dt><dd className="mono">{display(manifest.data?.response_sha256 ?? '—')}</dd></div></dl><div className="button-row"><button disabled={manifest.data?.request_complete !== 1} onClick={() => void save('request')}>Download request</button><button disabled={manifest.data?.response_complete !== 1} onClick={() => void save('response')}>Download response</button></div></section><section className="panel"><h2>Sanitized headers</h2><h3>Request</h3><pre>{JSON.stringify(manifest.data?.requestHeaders ?? [], null, 2)}</pre><h3>Response</h3><pre>{JSON.stringify(manifest.data?.responseHeaders ?? [], null, 2)}</pre></section></div></QueryState>;
}

function Statistics() {
  const query = useApiQuery<{ summary: Record<string, Json>; byProvider: Array<Record<string, Json>>; byModel: Array<Record<string, Json>>; buckets: Array<Record<string, Json>> }>('/api/v1/stats');
  const summary = query.data?.summary ?? {};
  const maximum = Math.max(1, ...(query.data?.buckets ?? []).map((bucket) => typeof bucket.requests === 'number' ? bucket.requests : 0));
  return <section><PageHeader eyebrow="Durable aggregates" title="Statistics" subtitle="Costs are estimates only when a verified pricing snapshot exists; unknown models remain null." /><QueryState loading={query.loading} error={query.error} empty={!query.data || summary.requests === 0}>
    <div className="summary-strip"><Metric label="Requests" value={formatNumber(summary.requests)} /><Metric label="Errors" value={formatNumber(summary.errors)} /><Metric label="Avg latency" value={formatDuration(summary.average_total_ms)} /><Metric label="Input tokens" value={formatNumber(summary.input_tokens)} /><Metric label="Output tokens" value={formatNumber(summary.output_tokens)} /><Metric label="Estimated cost" value={summary.estimated_cost_microusd ? `$${(Number(summary.estimated_cost_microusd) / 1_000_000).toFixed(4)}` : 'unknown'} /></div>
    <section className="panel chart-panel"><h2>Hourly volume</h2><div className="bars" aria-hidden="true">{query.data?.buckets.map((bucket) => <div key={display(bucket.bucket_ms)} style={{ height: `${Math.max(3, Number(bucket.requests) / maximum * 100)}%` }} title={`${formatTime(bucket.bucket_ms)}: ${display(bucket.requests)}`} />)}</div><table><thead><tr><th>Hour</th><th>Requests</th><th>Errors</th><th>Avg latency</th><th>Avg TTFB</th></tr></thead><tbody>{query.data?.buckets.map((bucket) => <tr key={display(bucket.bucket_ms)}><td>{formatTime(bucket.bucket_ms)}</td><td>{formatNumber(bucket.requests)}</td><td>{formatNumber(bucket.errors)}</td><td>{formatDuration(bucket.average_total_ms)}</td><td>{formatDuration(bucket.average_ttfb_ms)}</td></tr>)}</tbody></table></section>
    <div className="inspector-grid"><StatTable title="Providers" rows={query.data?.byProvider ?? []} first="provider" /><StatTable title="Models" rows={query.data?.byModel ?? []} first="model" /></div>
  </QueryState></section>;
}
function StatTable({ title, rows, first }: { title: string; rows: Array<Record<string, Json>>; first: string }) { return <section className="panel"><h2>{title}</h2><table><thead><tr><th>{first}</th><th>Requests</th><th>Input</th><th>Output</th></tr></thead><tbody>{rows.map((row) => <tr key={display(row[first])}><td>{display(row[first])}</td><td>{formatNumber(row.requests)}</td><td>{formatNumber(row.input_tokens)}</td><td>{formatNumber(row.output_tokens)}</td></tr>)}</tbody></table></section>; }

function SystemStatus() {
  const query = useApiQuery<Record<string, Json>>('/api/v1/system');
  const durable = query.data?.durable && typeof query.data.durable === 'object' && !Array.isArray(query.data.durable) ? query.data.durable : {};
  const raw = query.data?.raw && typeof query.data.raw === 'object' && !Array.isArray(query.data.raw) ? query.data.raw : {};
  return <section><PageHeader eyebrow="Recorder health" title="System & storage" subtitle="Queue pressure, parser failures, retention, and file growth are visible here." /><QueryState loading={query.loading} error={query.error} empty={!query.data}><div className="summary-strip"><Metric label="Health" value={display(query.data?.status)} /><Metric label="Parser failures" value={formatNumber(durable.parserFailures)} /><Metric label="Raw retained" value={formatNumber(raw.retained)} /><Metric label="Pending writes" value={formatNumber(raw.pendingWrites)} /></div><div className="inspector-grid"><StatusPanel title="Durable store" data={durable} /><StatusPanel title="Raw store" data={raw} /></div></QueryState></section>;
}
function StatusPanel({ title, data }: { title: string; data: Record<string, Json> }) { return <section className="panel"><h2>{title}</h2><dl>{Object.entries(data).map(([key, value]) => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{typeof value === 'object' ? <code>{JSON.stringify(value)}</code> : display(value ?? '—')}</dd></div>)}</dl></section>; }

export function App() { return <ApiProvider><Layout /></ApiProvider>; }
