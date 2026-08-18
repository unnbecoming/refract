import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RefractConfig } from '../src/config.js';

export interface HttpResult {
  status: number;
  statusMessage: string;
  rawHeaders: string[];
  body: Buffer;
}

export function testConfig(origin: URL, adminToken: Buffer | null = null): RefractConfig {
  return {
    data: { host: '127.0.0.1', port: 0 },
    admin: { host: '127.0.0.1', port: 0, token: adminToken },
    upstreams: { anthropic: origin, openai: origin },
    timeouts: { upstreamHeadersMs: 1_000, upstreamIdleMs: 1_000, shutdownGraceMs: 1_000 },
  };
}

export function listen(server: http.Server): Promise<URL> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo;
      resolve(new URL(`http://127.0.0.1:${address.port}`));
    });
  });
}

export function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export function request(url: URL, options: http.RequestOptions & { body?: Buffer } = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const body = options.body;
    const request = http.request(url, options, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        statusMessage: response.statusMessage ?? '',
        rawHeaders: response.rawHeaders,
        body: Buffer.concat(chunks),
      }));
    });
    request.once('error', reject);
    if (body) request.end(body);
    else request.end();
  });
}
