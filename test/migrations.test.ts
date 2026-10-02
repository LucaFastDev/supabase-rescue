import { describe, expect, it } from 'vitest';
import { CI_PATTERN, RULES, lintSql, migrationsCheck, splitStatements } from '../src/checks/migrations.ts';
import { tempDir, writeFiles } from './repo.ts';

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
    expect(drop!.fix.snippet?.code).toContain(`grep -niP '${CI_PATTERN}'`);
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
  // grep -P and JavaScript agree on everything this pattern uses.
  const ci = new RegExp(CI_PATTERN, 'i');

  it.each(Object.entries(BLOCKER_CASES))('flags %s', (_id, sql) => {
    expect(ci.test(sql)).toBe(true);
  });

  it.each(ADDITIVE_CASES)('passes %s', (sql) => {
    expect(ci.test(sql)).toBe(false);
  });
});
