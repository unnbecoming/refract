import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRefractServer } from '../src/proxy/server.js';
import { testConfig } from './helpers.js';

const responseBody = Buffer.alloc(2 * 1024 * 1024, 0x5a);
const upstream = http.createServer((request, response) => {
  request.resume();
  request.on('end', () => { response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(responseBody.length) }); response.end(responseBody); });
});
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const address = upstream.address();
if (!address || typeof address === 'string') throw new Error('mock upstream did not bind');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-soak-'));
const config = testConfig(new URL(`http://127.0.0.1:${address.port}`));
config.durablePath = path.join(directory, 'durable.db');
config.parserMaxBodyBytes = 64 * 1024;
config.raw = { path: path.join(directory, 'raw.db'), retentionHours: 1, pruneIntervalSeconds: 3600, deleteBatchSize: 2, maxDbBytes: 8 * 1024 * 1024, targetDbBytes: 6 * 1024 * 1024, maxExchangeBytes: 3 * 1024 * 1024, blockBytes: 64 * 1024, maxQueuedWrites: 512 };
const proxy = createRefractServer(config);
const addresses = await proxy.start();
const endpoint = `http://127.0.0.1:${addresses.data.port}/v1/responses`;
let peakRss = process.memoryUsage().rss;
const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
const initialRss = process.memoryUsage().rss;
async function one(): Promise<{ bytes: number; ttfbMs: number }> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const outgoing = http.request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' } }, (incoming) => {
      const ttfbMs = performance.now() - started;
      let bytes = 0;
      incoming.on('data', (chunk: Buffer) => { bytes += chunk.length; });
      incoming.once('end', () => resolve({ bytes, ttfbMs }));
    });
    outgoing.once('error', reject);
    outgoing.end('{}');
  });
}
try {
  const started = performance.now();
  const first = await Promise.all(Array.from({ length: 12 }, one));
  await proxy.raw?.flush();
  await proxy.raw?.prune();
  const firstPeak = peakRss;
  const second = await Promise.all(Array.from({ length: 12 }, one));
  await proxy.raw?.flush();
  await proxy.raw?.prune();
  const elapsedMs = performance.now() - started;
  const results = [...first, ...second];
  const ttfb = results.map((result) => result.ttfbMs).sort((a, b) => a - b);
  const p95TtfbMs = ttfb[Math.floor(ttfb.length * 0.95)] ?? 0;
  const retained = await proxy.raw?.retentionStatus();
  const usedBytes = typeof retained?.usedBytes === 'number' ? retained.usedBytes : Infinity;
  if (results.some((result) => result.bytes !== responseBody.length)) throw new Error('soak response truncation');
  if (p95TtfbMs > 2_000) throw new Error(`soak p95 TTFB exceeded: ${p95TtfbMs}`);
  if (peakRss - firstPeak > 64 * 1024 * 1024 || peakRss - initialRss > 192 * 1024 * 1024) throw new Error('resident memory did not plateau');
  if (usedBytes > config.raw.maxDbBytes) throw new Error(`raw used bytes exceeded cap: ${usedBytes}`);
  process.stdout.write(`${JSON.stringify({ requests: results.length, responseMiB: responseBody.length / 1024 / 1024, elapsedMs: Math.round(elapsedMs), p95TtfbMs: Math.round(p95TtfbMs), throughputMiBPerSecond: Math.round((results.length * responseBody.length / 1024 / 1024) / (elapsedMs / 1000)), rssDeltaMiB: Math.round((peakRss - initialRss) / 1024 / 1024), rawUsedMiB: Math.round(usedBytes / 1024 / 1024) })}\n`);
} finally {
  clearInterval(sample);
  await proxy.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  fs.rmSync(directory, { recursive: true, force: true });
}
