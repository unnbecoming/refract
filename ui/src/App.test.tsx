// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axe from 'axe-core';
import { App } from './App.js';

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function eventStream(): Response {
  return new Response(new ReadableStream({ start() { /* remains connected until the component aborts */ } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Refract UI', () => {
  test('renders live activity accessibly from the versioned API', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.startsWith('/api/v1/events')) return Promise.resolve(eventStream());
      if (url === '/api/v1/transport') return Promise.resolve(json({ active: [], recent: [], durable: { available: true }, raw: { enabled: true, available: true } }));
      return Promise.resolve(json({ error: { code: 'not_found' } }, 404));
    }));
    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
    expect(await screen.findByText('Recorder traffic')).toBeInTheDocument();
    expect(await screen.findAllByText('online')).toHaveLength(2);
    const results = await axe.run(document.body);
    expect(results.violations).toEqual([]);
  });

  test('shows the in-memory authentication boundary after a 401', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ error: { code: 'admin_unauthorized' } }, 401))));
    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);
    expect(await screen.findByRole('dialog', { name: 'Bearer token required' })).toBeInTheDocument();
    expect(screen.getByText(/never written to browser storage/i)).toBeInTheDocument();
  });

  test('renders a deep-linked safe transcript and keeps raw behind opt-in', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.startsWith('/api/v1/events')) return Promise.resolve(eventStream());
      if (url.endsWith('/transcript')) return Promise.resolve(json({ requestId: 'req_1', tailId: 'a'.repeat(64), items: [{ schemaVersion: 1, kind: 'message', role: 'assistant', content: [{ type: 'text', text: '[safe](https://example.com) <script>alert(1)</script>' }] }] }));
      if (url.startsWith('/api/v1/lineages/')) return Promise.resolve(json({ requestId: 'req_1', items: [] }));
      if (url === '/api/v1/requests/req_1') return Promise.resolve(json({ id: 'req_1', state: 'completed', raw_state: 'retained', occurrences: [] }));
      if (url === '/api/v1/raw/req_1') return Promise.resolve(json({ raw_state: 'retained', request_bytes: 10, response_bytes: 20, requestHeaders: [], responseHeaders: [] }));
      return Promise.resolve(json({ error: { code: 'not_found' } }, 404));
    }));
    render(<MemoryRouter initialEntries={['/requests/req_1']}><App /></MemoryRouter>);
    const link = await screen.findByRole('link', { name: 'safe' });
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(document.querySelector('script')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Raw opt-in' }));
    expect(screen.getByText(/Raw capture is separate sensitive data/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open raw inspector' }));
    expect(await screen.findByText('Retention')).toBeInTheDocument();
  });

  test('does not offer a dead raw-inspector action when downloads are disabled', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.startsWith('/api/v1/events')) return Promise.resolve(eventStream());
      if (url.endsWith('/transcript')) return Promise.resolve(json({ requestId: 'req_1', tailId: null, items: [] }));
      if (url.startsWith('/api/v1/lineages/')) return Promise.resolve(json({ requestId: 'req_1', items: [] }));
      if (url === '/api/v1/requests/req_1') return Promise.resolve(json({ id: 'req_1', state: 'completed', raw_state: 'retained', raw_download_enabled: false, occurrences: [] }));
      return Promise.resolve(json({ error: { code: 'not_found' } }, 404));
    }));
    render(<MemoryRouter initialEntries={['/requests/req_1']}><App /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('tab', { name: 'Raw opt-in' }));
    expect(await screen.findByRole('heading', { name: 'Raw inspector unavailable' })).toBeInTheDocument();
    expect(screen.getByText(/disabled by the operator/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open raw inspector' })).not.toBeInTheDocument();
  });

  test('shows a truthful empty request-browser state', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => requestUrl(input).startsWith('/api/v1/events')
      ? Promise.resolve(eventStream())
      : Promise.resolve(json({ items: [], nextCursor: null }))));
    render(<MemoryRouter initialEntries={['/requests']}><App /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('No matching records.')).toBeInTheDocument());
  });
});
