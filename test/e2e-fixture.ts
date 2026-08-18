import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRefractServer } from '../src/proxy/server.js';
import { testConfig } from './helpers.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-browser-'));
let count = 0;
const upstream = http.createServer((incoming, response) => {
  incoming.resume();
  incoming.on('end', () => {
    count += 1;
    const body = Buffer.from(JSON.stringify({ id: `resp_e2e_${count}`, object: 'response', model: 'gpt-e2e', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `browser answer ${count}`, annotations: [] }] }], usage: { input_tokens: 2, output_tokens: 3 } }));
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) });
    response.end(body);
  });
});
await new Promise<void>((resolve) => upstream.listen(28470, '127.0.0.1', resolve));
const config = testConfig(new URL('http://127.0.0.1:28470'));
config.data.port = 28472;
config.admin.port = 28471;
config.durablePath = path.join(directory, 'durable.db');
config.rawDownloadEnabled = true;
config.raw = { path: path.join(directory, 'raw.db'), retentionHours: 1, pruneIntervalSeconds: 3600, deleteBatchSize: 10, maxDbBytes: 64 * 1024 * 1024, targetDbBytes: 48 * 1024 * 1024, maxExchangeBytes: 1024 * 1024, blockBytes: 32, maxQueuedWrites: 100 };
const proxy = createRefractServer(config);
await proxy.start();
const control = http.createServer((request, response) => {
  if (request.url === '/expire') void proxy.raw?.prune(Date.now() + 2 * 3_600_000).then(() => { response.end('expired'); });
  else if (request.url === '/gap') { proxy.events.disconnectClients(); for (let index = 0; index < 520; index += 1) proxy.events.publish('gap_test', { index }); response.end('gap'); }
  else { response.statusCode = 404; response.end(); }
});
await new Promise<void>((resolve) => control.listen(28473, '127.0.0.1', resolve));
const stop = async () => {
  await proxy.close();
  await Promise.all([new Promise<void>((resolve) => upstream.close(() => resolve())), new Promise<void>((resolve) => control.close(() => resolve()))]);
  fs.rmSync(directory, { recursive: true, force: true });
  process.exit(0);
};
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
