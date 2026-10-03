import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The port choice lives in playwright.config.ts: E2E_PORT, or one derived from the checkout's path.
// Nothing else runs it in CI (CI runs `npm test`, not the e2e tests), so it is asserted here.

const KEYS = ['E2E_PORT', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'] as const;

type Config = {
  use: { baseURL: string };
  webServer: { command: string; url: string; reuseExistingServer: boolean };
};

async function loadConfig(): Promise<Config> {
  vi.resetModules();
  return (await import('../playwright.config.ts')).default as unknown as Config;
}

describe('playwright.config.ts port', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    // Keep the config from asking the demo stack for its URL and key.
    process.env.VITE_SUPABASE_URL = 'http://127.0.0.1:56321';
    process.env.VITE_SUPABASE_ANON_KEY = 'test-anon-key';
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('uses E2E_PORT for the base URL, the server URL and the dev server command', async () => {
    process.env.E2E_PORT = '24567';
    const config = await loadConfig();
    expect(config.use.baseURL).toBe('http://localhost:24567');
    expect(config.webServer.url).toBe('http://localhost:24567');
    expect(config.webServer.command).toContain('--port 24567 --strictPort');
  });

  it('derives a port in 20000-29999 from the working directory, the same on every load', async () => {
    delete process.env.E2E_PORT;
    const first = await loadConfig();
    const port = Number(new URL(first.use.baseURL).port);
    expect(port).toBeGreaterThanOrEqual(20000);
    expect(port).toBeLessThanOrEqual(29999);
    expect(first.webServer.url).toBe(first.use.baseURL);
    expect(first.webServer.command).toContain(`--port ${port} --strictPort`);

    delete process.env.E2E_PORT;
    const second = await loadConfig();
    expect(second.use.baseURL).toBe(first.use.baseURL);
  });

  it('reuses a dev server already on the port', async () => {
    process.env.E2E_PORT = '24567';
    const config = await loadConfig();
    expect(config.webServer.reuseExistingServer).toBe(true);
  });
});
