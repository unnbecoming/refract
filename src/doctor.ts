import { loadConfig } from './config.js';

const config = loadConfig();
process.stdout.write(`${JSON.stringify({
  status: 'valid',
  data: config.data,
  admin: { host: config.admin.host, port: config.admin.port, authenticated: config.admin.token !== null },
  upstreams: { anthropic: config.upstreams.anthropic.origin, openai: config.upstreams.openai.origin },
  durablePath: config.durablePath,
  raw: config.raw ? { enabled: true, path: config.raw.path, retentionHours: config.raw.retentionHours, maxDbBytes: config.raw.maxDbBytes } : { enabled: false },
  limits: config.limits,
}, null, 2)}\n`);
