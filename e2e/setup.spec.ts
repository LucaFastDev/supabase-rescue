import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { demoStack } from './demo-stack.ts';

// The e2e setup itself, without a browser or the stack: how the run finds the demo stack, and
// that its output and specs stay out of git and out of Vitest.

const STATUS = JSON.stringify({ API_URL: 'http://127.0.0.1:56321', ANON_KEY: 'status-anon-key' });
const noStatus = (): string => {
  throw new Error('the status should not be read');
};

test('takes the URL and key from the environment when both are set', () => {
  const env = { VITE_SUPABASE_URL: 'http://localhost:56321', VITE_SUPABASE_ANON_KEY: 'env-anon-key' };
  expect(demoStack(env, noStatus)).toEqual({ url: 'http://localhost:56321', anonKey: 'env-anon-key' });
});

test('takes them from the demo stack status when they are unset', () => {
  expect(demoStack({}, () => STATUS)).toEqual({ url: 'http://127.0.0.1:56321', anonKey: 'status-anon-key' });
});

test('takes only the unset one from the status', () => {
  const env = { VITE_SUPABASE_URL: 'http://localhost:56321' };
  expect(demoStack(env, () => STATUS)).toEqual({ url: 'http://localhost:56321', anonKey: 'status-anon-key' });
});

test('refuses a Supabase URL that is not on 127.0.0.1 or localhost', () => {
  for (const url of ['https://abcdefgh.supabase.co', 'http://127.0.0.1.example.com:56321', 'http://10.0.0.5:56321']) {
    const env = { VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: 'key' };
    expect(() => demoStack(env, noStatus)).toThrow(/refusing to run the e2e tests/);
  }
  const remoteStatus = JSON.stringify({ API_URL: 'https://abcdefgh.supabase.co', ANON_KEY: 'key' });
  expect(() => demoStack({}, () => remoteStatus)).toThrow(/refusing to run the e2e tests/);
});

test('fails clearly when the stack gives no status', () => {
  expect(() => demoStack({}, () => '')).toThrow(/demo stack gave no status/);
  expect(() => demoStack({}, () => '{}')).toThrow(/no API_URL or ANON_KEY/);
});

test("git ignores Playwright's output anywhere in the tree", () => {
  for (const dir of ['test-results', 'playwright-report']) {
    for (const path of [`${dir}/x`, `demo/${dir}/x`, `e2e/${dir}/x`]) {
      // check-ignore exits non-zero, so execFileSync throws, when the path is not ignored.
      expect(() => execFileSync('git', ['check-ignore', '--quiet', '--no-index', path])).not.toThrow();
    }
  }
});

test('Vitest does not collect the e2e specs', () => {
  const files = execFileSync('npx', ['vitest', 'list', '--filesOnly'], { encoding: 'utf8' }).split('\n');
  expect(files).toContain('test/cli.test.ts');
  expect(files.filter((file) => file.startsWith('e2e/'))).toEqual([]);
});
