import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Check, CheckContext } from '../src/checks/index.ts';
import { checks } from '../src/checks/index.ts';
import { main } from '../src/main.ts';
import type { MainOptions } from '../src/main.ts';
import { renderJson, renderMarkdown } from '../src/report.ts';
import { ROLE_SQL } from '../src/rolesql.ts';
import { RANK_CASES, finding } from './helpers.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = (name: string) => path.join(root, 'test', 'fixtures', name);
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const tool = { name: pkg.name, version: pkg.version };

let out: string;
beforeEach(async () => {
  out = await mkdtemp(path.join(os.tmpdir(), 'supabase-rescue-test-'));
});

async function run(argv: string[], options: MainOptions = {}) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    cwd: root,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    ...options,
  });
  return { code, stdout, stderr };
}

const fixed = (...findings: ReturnType<typeof finding>[]): Check => ({ id: 'a', run: () => findings });

describe('audit', () => {
  it('registers the database checks a to c and k, then checks d to j, in that order', () => {
    expect(checks.map((check) => check.id)).toEqual(['a', 'b', 'c', 'k', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
  });

  it('with no checks, writes an empty report.md and report.json to --out and exits 0', async () => {
    const result = await run(['audit', 'test/fixtures/empty-repo', '--out', out], { checks: [] });
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect((await readdir(out)).sort()).toEqual(['report.json', 'report.md']);
    const meta = { target: 'test/fixtures/empty-repo', tool };
    expect(await readFile(path.join(out, 'report.md'), 'utf8')).toBe(renderMarkdown([], meta));
    expect(await readFile(path.join(out, 'report.json'), 'utf8')).toBe(renderJson([], meta));
    expect(JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8')).tool).toEqual({
      name: 'supabase-rescue',
      version: pkg.version,
    });
  });

  it('writes to the current directory when --out is not given', async () => {
    const result = await run(['audit', fixture('empty-repo')], { cwd: out });
    expect(result.code).toBe(0);
    expect((await readdir(out)).sort()).toEqual(['report.json', 'report.md']);
  });

  it.each(RANK_CASES)('exits $exitCode when a check reports a $rank finding', async ({ rank, exitCode }) => {
    const result = await run(['audit', 'test/fixtures/empty-repo', '--out', out], {
      checks: [fixed(finding(rank))],
    });
    expect(result.code).toBe(exitCode);
  });

  it('runs every registered check and collects their findings, sorted', async () => {
    const registry: Check[] = [
      fixed(finding('low', { check: 'f', title: 'from f' })),
      { id: 'b', run: async () => [finding('high', { check: 'b', title: 'from b' })] },
    ];
    const result = await run(['audit', 'test/fixtures/empty-repo', '--out', out], { checks: registry });
    expect(result.code).toBe(1);
    const report = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8'));
    expect(report.findings.map((f: { title: string }) => f.title)).toEqual(['from b', 'from f']);
  });

  it('passes the absolute repo path, --db and the exposed schemas to each check', async () => {
    const seen: CheckContext[] = [];
    const recorder: Check = { id: 'a', run: (context) => (seen.push(context), []) };
    const db = 'postgresql://audit@127.0.0.1:56322/postgres';
    await run(['audit', 'test/fixtures/empty-repo', '--db', db, '--out', out], { checks: [recorder] });
    await run(['audit', 'test/fixtures/empty-repo', '--out', out], { checks: [recorder] });
    expect(seen).toEqual([
      { repoPath: fixture('empty-repo'), db, exposedSchemas: ['public'] },
      { repoPath: fixture('empty-repo'), exposedSchemas: ['public'] },
    ]);
  });

  it('gives byte-identical reports across two runs on the same input', async () => {
    const second = await mkdtemp(path.join(os.tmpdir(), 'supabase-rescue-test-'));
    const registry = [
      fixed(
        finding('manual', { check: 'd', title: 'Rotate a key' }),
        finding('critical', { check: 'a', location: { object: 'public.notes' } }),
        finding('medium', { check: 'e' }),
      ),
    ];
    await run(['audit', 'test/fixtures/empty-repo', '--out', out], { checks: registry });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await run(['audit', 'test/fixtures/empty-repo', '--out', second], { checks: registry });
    for (const file of ['report.md', 'report.json']) {
      const a = await readFile(path.join(out, file));
      const b = await readFile(path.join(second, file));
      expect(a.equals(b)).toBe(true);
    }
  });

  it.each([
    { name: 'a missing path', argv: ['audit', 'test/fixtures/no-such-dir'], error: 'error: test/fixtures/no-such-dir is not a directory\n' },
    { name: 'a file instead of a directory', argv: ['audit', 'test/fixtures/not-a-directory.txt'], error: 'error: test/fixtures/not-a-directory.txt is not a directory\n' },
    { name: 'no path at all', argv: ['audit'], error: 'usage: audit <path> [--db <connection string>] [--out <dir>] | role-sql\n' },
  ])('exits 2 with a one-line error for $name, writing nothing', async ({ argv, error }) => {
    const result = await run([...argv, '--out', out]);
    expect(result).toEqual({ code: 2, stdout: '', stderr: error });
    expect(await readdir(out)).toEqual([]);
  });

  it('exits 2 for an unknown option', async () => {
    const result = await run(['audit', 'test/fixtures/empty-repo', '--bogus', '--out', out]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/^error: .*bogus.*\n$/);
  });
});

describe('role-sql', () => {
  it('prints the role SQL and exits 0', async () => {
    const result = await run(['role-sql']);
    expect(result).toEqual({ code: 0, stdout: ROLE_SQL, stderr: '' });
  });
});

it('exits 2 for an unknown command', async () => {
  const result = await run(['scan', 'demo']);
  expect(result.code).toBe(2);
});

describe('the cli.ts entry point', () => {
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root, encoding: 'utf8' });

  it('sets the process exit code to 2 for a bad path', () => {
    const result = cli('audit', 'test/fixtures/no-such-dir');
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('error: test/fixtures/no-such-dir is not a directory\n');
  });

  it('runs an audit and exits 0', () => {
    const result = cli('audit', 'test/fixtures/empty-repo', '--out', out);
    expect(result.status).toBe(0);
  });

  it('prints role-sql to stdout and exits 0', () => {
    const result = cli('role-sql');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(ROLE_SQL);
  });
});
