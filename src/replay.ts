import { loadConfig } from './config.js';
import { replayRetainedRaw } from './providers/recording.js';
import { DurableStore } from './storage/durable-store.js';
import { RawCaptureStore } from './storage/raw-store.js';

export async function replay(requestId: string): Promise<void> {
  if (!requestId) throw new Error('usage: npm run replay -- <request-id>');
  const config = loadConfig();
  if (!config.raw) throw new Error('raw capture is disabled');
  const durable = await DurableStore.open(config.durablePath);
  const raw = new RawCaptureStore(config.raw);
  try {
    await raw.ready();
    const knownSecrets = Object.values(config.credentials).flatMap((credential) => [
      credential.secretValue,
      Buffer.from(credential.wireValue),
    ]);
    await replayRetainedRaw({ requestId, durable, raw, maximumBodyBytes: config.parserMaxBodyBytes, knownSecrets });
  } finally {
    await Promise.all([durable.close(), raw.close().catch(() => undefined)]);
  }
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  replay(process.argv[2] ?? '').then(() => {
    process.stdout.write('replay complete\n');
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'replay failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
