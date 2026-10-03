import { createHash } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';
import { demoStack } from './e2e/demo-stack.ts';

// The demo app's dev server, pointed at the demo's own local stack (see e2e/demo-stack.ts). The
// values go back into process.env so Playwright's workers, which load this file again, inherit
// them instead of asking the stack a second time.
const stack = demoStack();
process.env.VITE_SUPABASE_URL = stack.url;
process.env.VITE_SUPABASE_ANON_KEY = stack.anonKey;

// One port per checkout: E2E_PORT, or one derived from this checkout's path. Set into process.env
// so Playwright's workers, which load this file again, inherit the same port.
process.env.E2E_PORT ||= String(
  20000 + (parseInt(createHash('sha256').update(process.cwd()).digest('hex').slice(0, 8), 16) % 10000),
);
const PORT = Number(process.env.E2E_PORT);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev --prefix demo -- --port ${PORT} --strictPort`,
    url: baseURL,
    // Reuse is safe: the port is this checkout's own (E2E_PORT or derived from its path), so a
    // server already on it can only be this checkout's.
    reuseExistingServer: true,
    // Show Vite's "Local:" line, so a run's output says which port it used.
    stdout: 'pipe',
    env: {
      VITE_SUPABASE_URL: stack.url,
      VITE_SUPABASE_ANON_KEY: stack.anonKey,
    },
  },
});
