import { defineConfig } from '@playwright/test';
import lighthouse from '../e2e/playwright.config.lighthouse';

if (process.env.E2E_BASE_URL !== 'http://127.0.0.1:15312') {
  throw new Error('Set E2E_BASE_URL=http://127.0.0.1:15312; other destinations are refused');
}

export default defineConfig({
  ...lighthouse,
  globalSetup: require.resolve('./tests/setup'),
  testDir: process.env.OPENSCHOOL_QA_LIGHTHOUSE ? '../e2e/lighthouse' : './tests',
  testMatch: process.env.OPENSCHOOL_QA_LIGHTHOUSE ? 'load.spec.ts' : 'branding.spec.ts',
  outputDir: process.env.OPENSCHOOL_QA_LIGHTHOUSE
    ? '../e2e/specs/.test-results/branding-performance'
    : '../e2e/specs/.test-results/branding',
  timeout: process.env.OPENSCHOOL_QA_LIGHTHOUSE ? 300_000 : 60_000,
  workers: 1,
  webServer: (Array.isArray(lighthouse.webServer) ? lighthouse.webServer : []).map((server) => ({
    ...server,
    env: {
      ...server.env,
      APP_TITLE: 'OpenSchool-Chat',
      E2E_LATENCY_MONGO_DELAY_MS: process.env.OPENSCHOOL_QA_LIGHTHOUSE ? '250' : '0',
      OPENSCHOOL_RETURN_URL: 'http://127.0.0.1:15311/simulation/ai-circles',
    },
  })),
});
