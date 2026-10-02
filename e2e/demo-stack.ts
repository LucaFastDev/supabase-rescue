import { execFileSync } from 'node:child_process';

export interface DemoStack {
  url: string;
  anonKey: string;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** The demo stack's status, as `npx supabase status --workdir demo -o json` prints it. */
export function readDemoStatus(): string {
  return execFileSync('npx', ['supabase', 'status', '--workdir', 'demo', '-o', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * The Supabase URL and anon key the demo app is started with: VITE_SUPABASE_URL and
 * VITE_SUPABASE_ANON_KEY from the environment, or, for whichever is unset, the demo stack's
 * API_URL and ANON_KEY. Throws unless the URL is on 127.0.0.1 or localhost, so the e2e tests
 * never sign in to, or write to, a real project.
 */
export function demoStack(
  env: Record<string, string | undefined> = process.env,
  status: () => string = readDemoStatus,
): DemoStack {
  let url = env.VITE_SUPABASE_URL || undefined;
  let anonKey = env.VITE_SUPABASE_ANON_KEY || undefined;
  if (url === undefined || anonKey === undefined) {
    let parsed: { API_URL?: unknown; ANON_KEY?: unknown };
    try {
      parsed = JSON.parse(status()) as typeof parsed;
    } catch (error) {
      throw new Error(
        'VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is unset, and the demo stack gave no status; ' +
          'start it with npx supabase start --workdir demo',
        { cause: error },
      );
    }
    url ??= typeof parsed.API_URL === 'string' ? parsed.API_URL : undefined;
    anonKey ??= typeof parsed.ANON_KEY === 'string' ? parsed.ANON_KEY : undefined;
  }
  if (url === undefined || anonKey === undefined) {
    throw new Error('the demo stack status has no API_URL or ANON_KEY');
  }
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`VITE_SUPABASE_URL is not a URL: ${url}`);
  }
  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error(`refusing to run the e2e tests against ${url}: only 127.0.0.1 or localhost`);
  }
  return { url, anonKey };
}
