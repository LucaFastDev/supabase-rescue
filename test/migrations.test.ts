import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CI_PATTERN, CI_SCRIPT, RULES, lintSql, migrationsCheck, splitStatements } from '../src/checks/migrations.ts';
import { commitAll, git, gitRepo, tempDir, writeFiles } from './repo.ts';

// Ported from ai-hq's scripts/check-migration.test.mjs, without the waiver and --base cases.
const blockers = (sql: string) => lintSql(sql).map((f) => f.rule.id);

const BLOCKER_CASES: Record<string, string> = {
  'drop-column': 'alter table public.requests drop column priority;',
  'drop-table': 'drop table public.old_things;',
  'rename-column': 'alter table public.requests rename column title to name;',
  'rename-table': 'alter table public.requests rename to asks;',
  'set-not-null': 'alter table public.requests alter column repo set not null;',
  'alter-type': 'alter table public.requests alter column priority type integer using 1;',
  'add-not-null-no-default': 'alter table public.requests add column owner text not null;',
  truncate: 'truncate public.requests;',
};

const ADDITIVE_CASES = [
  'alter table public.requests add column owner text;',
  "alter table public.requests add column owner text not null default '';",
  'alter table public.requests add column n int generated always as (1) stored not null;',
  'create table if not exists public.x (id uuid primary key, name text not null);',
  'create or replace function public.f() returns void language sql as $$ select 1 $$;',
  'revoke execute on function public.f() from public, anon, authenticated;',
];

describe('lintSql', () => {
  it('ports exactly the eight blocker rules', () => {
    expect(RULES.map((r) => r.id)).toEqual(Object.keys(BLOCKER_CASES));
  });

  it.each(Object.entries(BLOCKER_CASES))('blocks %s', (id, sql) => {
    expect(blockers(sql)).toEqual([id]);
  });

  it.each(ADDITIVE_CASES)('passes the additive change %s', (sql) => {
    expect(blockers(sql)).toEqual([]);
  });

  it('ignores words that only appear in comments', () => {
    expect(blockers('-- we never drop column priority here\n/* nor truncate */\nselect 1;')).toEqual([]);
  });

  it('checks the statements inside a dollar-quoted function body', () => {
    const sql = [
      'create or replace function public.reset() returns void language plpgsql as $$',
      'begin',
      '  truncate public.requests;',
      'end;',
      '$$;',
    ].join('\n');
    expect(lintSql(sql).map((f) => [f.rule.id, f.line])).toEqual([['truncate', 1]]);
  });

  it('reports the line each statement starts on, after comments and blank lines', () => {
    const sql = '-- header\n\ncreate table public.a (id int);\n\n/* note */\nalter table public.a\n  drop column id;\n';
    expect(splitStatements(sql).map((s) => s.line)).toEqual([3, 6]);
    expect(lintSql(sql).map((f) => [f.rule.id, f.line])).toEqual([['drop-column', 6]]);
  });
});

describe('check f', () => {
  it('gives one low finding per hit, at the file and the line its statement starts', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      'supabase/migrations/20260101000000_init.sql': 'create table public.a (id int, note text);\n',
      'supabase/migrations/20260102000000_drop.sql':
        '-- tidy up\nalter table public.a add column owner text;\n\nalter table public.a\n  drop column note;\ntruncate public.a;\n',
      'supabase/migrations/README.md': 'drop table public.a;\n',
    });
    const findings = await migrationsCheck.run({ repoPath: root, exposedSchemas: ['public'] });
    expect(findings.map((f) => [f.severity, f.location, f.title])).toEqual([
      ['low', { file: 'supabase/migrations/20260102000000_drop.sql', line: 4 }, 'Migration drops a column'],
      ['low', { file: 'supabase/migrations/20260102000000_drop.sql', line: 6 }, 'Migration deletes every row of a table'],
    ]);
    const [drop] = findings;
    expect(drop!.check).toBe('f');
    expect(drop!.why).toContain(RULES.find((r) => r.id === 'drop-column')!.message);
    expect(drop!.fix.snippet?.language).toBe('yaml');
    expect(drop!.fix.snippet?.code).toContain('runs-on: ubuntu-latest');
    expect(drop!.fix.snippet?.code).toContain('origin/${{ github.base_ref }}...HEAD');
    expect(drop!.fix.snippet?.code).toContain(`run: |\n${CI_SCRIPT.replace(/^(?=.)/gm, '          ')}`);
    expect(CI_SCRIPT).toContain(`if ($line =~ /${CI_PATTERN}/i)`);
  });

  it('finds nothing in additive migrations', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'supabase/migrations/20260101000000_init.sql': ADDITIVE_CASES.join('\n') });
    expect(await migrationsCheck.run({ repoPath: root, exposedSchemas: ['public'] })).toEqual([]);
  });

  it('finds nothing when there is no migrations folder', async () => {
    const root = await tempDir();
    expect(await migrationsCheck.run({ repoPath: root, exposedSchemas: ['public'] })).toEqual([]);
  });
});

describe('the CI step it suggests', () => {
  // Perl and JavaScript agree on everything this pattern uses.
  const ci = new RegExp(CI_PATTERN, 'i');

  it.each(Object.entries(BLOCKER_CASES))('flags %s', (_id, sql) => {
    expect(ci.test(sql)).toBe(true);
  });

  it.each(ADDITIVE_CASES)('passes %s', (sql) => {
    expect(ci.test(sql)).toBe(false);
  });
});

describe('the CI step, run in a git repo', () => {
  const DIR = 'supabase/migrations';

  /** A repo whose origin/main holds one migration; the pull request's commits go on top. */
  async function pullRequest(added: Record<string, string>): Promise<string> {
    const root = await gitRepo();
    await writeFiles(root, { [`${DIR}/20260101000000_init.sql`]: 'create table public.a (id int, b text);\n' });
    commitAll(root, 'base');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    await writeFiles(root, added);
    commitAll(root, 'the pull request');
    return root;
  }

  /** Runs the step's script as GitHub's `shell: bash` does, with main as the base branch. */
  function step(root: string) {
    const script = CI_SCRIPT.replaceAll('${{ github.base_ref }}', 'main');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { cwd: root, encoding: 'utf8' });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it.each([
    { name: 'a space', file: '20261001000000_drop old column.sql' },
    { name: 'a non-ASCII character', file: '20261001000000_café.sql' },
    { name: 'a quote', file: '20261001000000_say "bye".sql' },
  ])('fails for a blocking migration whose name has $name, naming the file', async ({ file }) => {
    const root = await pullRequest({ [`${DIR}/${file}`]: 'alter table public.a drop column b;\n' });
    const result = step(root);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(`${DIR}/${file}:1:alter table public.a drop column b;\n`);
    expect(result.output).toContain(`::error file=${DIR}/${file}::${DIR}/${file} is not backward-compatible`);
  });

  it('fails when a second new migration blocks and the first does not', async () => {
    const root = await pullRequest({
      [`${DIR}/20261001000000_add note.sql`]: 'alter table public.a add column note text;\n',
      [`${DIR}/20261001000001_truncate.sql`]: 'truncate public.a;\n',
    });
    const result = step(root);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`${DIR}/20261001000001_truncate.sql is not backward-compatible`);
    expect(result.output).not.toContain('20261001000000_add note.sql is not');
  });

  it('passes additive migrations, whatever their names', async () => {
    const root = await pullRequest({
      [`${DIR}/20261001000000_add note café.sql`]: 'alter table public.a add column note text;\n',
      [`${DIR}/20261001000001_new table.sql`]: 'create table public.c (id int not null);\n',
    });
    const result = step(root);
    expect(result).toEqual({ status: 0, output: '' });
  });

  it('passes when the pull request adds no migration', async () => {
    const root = await pullRequest({ 'README.md': 'docs\n' });
    expect(step(root)).toEqual({ status: 0, output: '' });
  });

  it('fails, naming the file, when grep cannot read a new migration', async () => {
    const root = await pullRequest({ [`${DIR}/20261001000000_gone away.sql`]: 'alter table public.a add column note text;\n' });
    await rm(path.join(root, DIR, '20261001000000_gone away.sql'));
    const result = step(root);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`::error file=${DIR}/20261001000000_gone away.sql::Could not check ${DIR}/20261001000000_gone away.sql: perl exited 2.`);
  });

  it('fails when it cannot list the new migrations', async () => {
    const root = await pullRequest({ [`${DIR}/20261001000000_add.sql`]: 'alter table public.a add column note text;\n' });
    git(root, 'update-ref', '-d', 'refs/remotes/origin/main');
    const result = step(root);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('::error::Could not list the migrations this pull request adds.');
  });
});
