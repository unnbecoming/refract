import { loadConfig } from './config.js';
import { log } from './logging.js';
import { createRefractServer } from './proxy/server.js';

export async function main(): Promise<void> {
  const config = loadConfig();
  const server = createRefractServer(config);
  const addresses = await server.start();
  log.info({ data: addresses.data, admin: addresses.admin }, 'refract listening');

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'refract draining');
    await server.close();
  };
  process.once('SIGTERM', () => { void stop('SIGTERM'); });
  process.once('SIGINT', () => { void stop('SIGINT'); });
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  main().catch((error: unknown) => {
    log.fatal({ error }, 'refract startup failed');
    process.exitCode = 1;
  });
}
