import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.e2e.ts',
  timeout: 30_000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:28471', trace: 'retain-on-failure' },
  webServer: {
    command: 'npx tsx test/e2e-fixture.ts',
    url: 'http://127.0.0.1:28471/health/ready',
    timeout: 30_000,
    reuseExistingServer: false,
  },
});
