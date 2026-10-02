import { defineConfig, devices } from '@playwright/test';
import { demoStack } from './e2e/demo-stack.ts';

// The demo app's dev server, pointed at the demo's own local stack (see e2e/demo-stack.ts). The
// values go back into process.env so Playwright's workers, which load this file again, inherit
// them instead of asking the stack a second time.
const stack = demoStack();
process.env.VITE_SUPABASE_URL = stack.url;
process.env.VITE_SUPABASE_ANON_KEY = stack.anonKey;

const baseURL = 'http://localhost:7173';

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
    command: 'npm run dev --prefix demo',
    url: baseURL,
    // Never test a dev server some other checkout left running: it may hold other code or point
    // at another stack. Port 7173 is strict, so a busy port fails the run.
    reuseExistingServer: false,
    env: {
      VITE_SUPABASE_URL: stack.url,
      VITE_SUPABASE_ANON_KEY: stack.anonKey,
    },
  },
});
