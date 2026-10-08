import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { functionsCheck } from '../src/checks/functions.ts';
import { splitSqlStatements } from '../src/checks/sql-statements.ts';
import type { Finding } from '../src/findings.ts';
import type { Fixture } from './database.ts';
import { inSchema, openFixture } from './database.ts';
import { tempDir, writeFiles } from './repo.ts';

/** Runs check c without --db on a repo holding these migrations, by file name. */
async function audit(migrations: Record<string, string>, exposedSchemas = ['public']): Promise<Finding[]> {
  const root = await tempDir();
  await writeFiles(root, Object.fromEntries(Object.entries(migrations).map(([name, sql]) => [`supabase/migrations/${name}`, sql])));
  return functionsCheck.run({ repoPath: root, exposedSchemas });
}

/** The 1-based line of the first line of `text` that starts with `start`. */
const lineOf = (text: string, start: string) => text.split('\n').findIndex((l) => l.startsWith(start)) + 1;

const TABLE = 'create table public.reports (id uuid primary key, body text);\n\n';

// A plpgsql body with two semicolons, and security definer before it.
const REPORTS = `${TABLE}-- The report for one id.
create function public.get_report(p_id uuid)
returns setof public.reports
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query select * from public.reports where id = p_id;
end;
$$;

grant execute on function public.get_report(uuid) to authenticated;
`;

// The same, with security definer after the body.
const REPORTS_DEFINER_LAST = `${TABLE}create or replace function public.get_report(p_id uuid)
returns setof public.reports
set search_path = ''
as $$
begin
  return query select * from public.reports where id = p_id;
end;
$$ language plpgsql security definer;

grant execute on function public.get_report(uuid) to authenticated;
`;

const FIRST = '20260101000000_reports.sql';
const LATER = '20260102000000_lock_down.sql';

describe('check c without --db: definer functions the migrations leave executable by PUBLIC', () => {
  it('reports a definer granted to authenticated only as one high finding at its create statement', async () => {
    const findings = await audit({ [FIRST]: REPORTS });
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(finding).toMatchObject({
      check: 'c',
      severity: 'high',
      owner: 'Anyone on the internet can run a database function with full rights.',
      title: "Function public.get_report runs with its owner's rights and the migrations let anyone call it",
      location: { file: `supabase/migrations/${FIRST}`, line: lineOf(REPORTS, 'create function') },
    });
    expect(finding!.why).toMatch(/anon .* can execute it through PUBLIC, since anon is a member of PUBLIC/);
    expect(finding!.why).toMatch(/without --db, so it read only the migrations and cannot confirm what the live database allows/);
    expect(finding!.fix.snippet!.code).toBe(
      'revoke execute on function public.get_report(p_id uuid) from public, anon;\n-- Then run the audit with --db: it confirms whether anon can still execute it in the live database.\n',
    );
    expect(finding!.fix.text).toContain('--db');
  });

  it('reports nothing when a later migration revokes it from public', async () => {
    expect(await audit({ [FIRST]: REPORTS, [LATER]: 'revoke execute on function public.get_report(uuid) from public;\n' })).toEqual([]);
  });

  it('still reports it when a later migration revokes it from anon only', async () => {
    const findings = await audit({ [FIRST]: REPORTS, [LATER]: 'revoke execute on function public.get_report(uuid) from anon;\n' });
    expect(findings.map((f) => [f.severity, f.location])).toEqual([['high', { file: `supabase/migrations/${FIRST}`, line: lineOf(REPORTS, 'create function') }]]);
  });

  it('finds security definer written after the body', async () => {
    const findings = await audit({ [FIRST]: REPORTS_DEFINER_LAST });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      check: 'c',
      severity: 'high',
      location: { file: `supabase/migrations/${FIRST}`, line: lineOf(REPORTS_DEFINER_LAST, 'create or replace function') },
    });
    expect(findings[0]!.fix.snippet!.code).toContain('revoke execute on function public.get_report(p_id uuid) from public, anon;');
  });

  it('reports nothing for a definer in a schema that is not exposed', async () => {
    const hidden = { [FIRST]: REPORTS.replaceAll('public.get_report', 'private.get_report') };
    expect(await audit(hidden)).toEqual([]);
    expect((await audit(hidden, ['public', 'private'])).map((f) => f.title)).toEqual([
      "Function private.get_report runs with its owner's rights and the migrations let anyone call it",
    ]);
  });

  it('reports nothing for a security invoker function or one with no security clause', async () => {
    expect(await audit({ [FIRST]: REPORTS.replace('security definer', 'security invoker') })).toEqual([]);
    expect(await audit({ [FIRST]: REPORTS.replace('security definer\n', '') })).toEqual([]);
  });

  it('counts alter default privileges revoking from public only when it comes before the create', async () => {
    const defaults = 'alter default privileges in schema public revoke execute on functions from public;\n';
    expect(await audit({ [FIRST]: defaults + REPORTS })).toEqual([]);
    expect(await audit({ [FIRST]: REPORTS, [LATER]: defaults })).toHaveLength(1);
    // With no `in schema`, for every schema.
    expect(await audit({ [FIRST]: `alter default privileges for role postgres revoke execute on functions from public;\n${REPORTS}` })).toEqual([]);
    // In another schema only, it does not cover public.
    expect(await audit({ [FIRST]: `alter default privileges in schema private revoke execute on functions from public;\n${REPORTS}` })).toHaveLength(1);
  });

  it('counts a revoke on all functions in the schema only when it comes after the create', async () => {
    const all = 'revoke execute on all functions in schema public from anon, public;\n';
    expect(await audit({ [FIRST]: REPORTS, [LATER]: all })).toEqual([]);
    expect(await audit({ '20251231000000_first.sql': all, [FIRST]: REPORTS })).toHaveLength(1);
  });

  it('counts revoke all, with public anywhere in the role list', async () => {
    expect(await audit({ [FIRST]: REPORTS, [LATER]: 'revoke all on function public.get_report from authenticated, public, anon;\n' })).toEqual([]);
  });

  it('reports nothing for a function a later migration drops, and reports it again once it is created after the drop', async () => {
    const drop = 'drop function public.get_report(uuid);\n';
    expect(await audit({ [FIRST]: REPORTS, [LATER]: drop })).toEqual([]);
    const findings = await audit({ [FIRST]: REPORTS, [LATER]: drop, '20260103000000_again.sql': REPORTS_DEFINER_LAST });
    expect(findings.map((f) => f.location)).toEqual([{ file: 'supabase/migrations/20260103000000_again.sql', line: lineOf(REPORTS_DEFINER_LAST, 'create or replace function') }]);
  });

  it('reports a function granted to anon even when it is revoked from public, unless a later revoke takes it from anon', async () => {
    const revokePublic = 'revoke execute on function public.get_report(uuid) from public;\n';
    const grantAnon = 'grant execute on function public.get_report(uuid) to anon, authenticated;\n';
    const findings = await audit({ [FIRST]: REPORTS + revokePublic + grantAnon });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.why).toContain('A migration grants EXECUTE on it to anon');
    expect(await audit({ [FIRST]: REPORTS + revokePublic + grantAnon, [LATER]: 'revoke execute on function public.get_report(uuid) from anon;\n' })).toEqual([]);
    // A revoke from anon before the grant does not take it away.
    expect(await audit({ [FIRST]: REPORTS + revokePublic + 'revoke execute on function public.get_report(uuid) from anon;\n' + grantAnon })).toHaveLength(1);
  });

  it('ignores comments, and code inside other statements\' bodies', async () => {
    expect(
      await audit({
        [FIRST]: `-- create function public.get_report() returns int security definer language sql as $$ select 1 $$;
/* create function public.get_report() returns int
   security definer language sql as $$ select 1 $$; */
create function public.get_report() returns int language sql as $$ select 1 $$; -- security definer
do $body$ begin execute 'create function public.other() returns int security definer language sql as ''select 1'''; end $body$;
`,
      }),
    ).toEqual([]);
  });

  it('treats unqualified names as public, and compares names case-insensitively without their quotes', async () => {
    const create = 'CREATE FUNCTION "Public"."Get_Report"(p_id uuid) RETURNS int SECURITY DEFINER LANGUAGE sql AS $fn$ select 1; $fn$;\n';
    expect(await audit({ [FIRST]: create, [LATER]: 'revoke execute on function get_report(uuid) from public;\n' })).toEqual([]);
    expect((await audit({ [FIRST]: 'create function get_report() returns int security definer language sql as $$ select 1 $$;\n' })).map((f) => f.title)).toEqual([
      "Function public.get_report runs with its owner's rights and the migrations let anyone call it",
    ]);
  });

  it('treats overloads of one name as one function', async () => {
    const overloads = `${REPORTS}create function public.get_report(p_id uuid, p_limit int default 10) returns int security definer language sql as $$ select 1 $$;\n`;
    const findings = await audit({ [FIRST]: overloads });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.fix.snippet!.code).toContain('public.get_report(p_id uuid, p_limit int) from public, anon;');
    expect(await audit({ [FIRST]: overloads, [LATER]: 'revoke execute on function public.get_report(uuid) from public;\n' })).toEqual([]);
  });

  it('reports nothing when the repo has no migrations folder', async () => {
    expect(await functionsCheck.run({ repoPath: await tempDir(), exposedSchemas: ['public'] })).toEqual([]);
  });
});

describe('splitSqlStatements', () => {
  it('keeps dollar-quoted bodies, string literals and quoted identifiers whole, and blanks their contents in code', () => {
    const sql = `create function f() returns int as $tag$ begin; select ';'; end; $tag$ language plpgsql;
select 'a;b', "c;d" -- e;f
;`;
    const statements = splitSqlStatements(sql);
    expect(statements.map((s) => [s.text.trim(), s.line])).toEqual([
      ["create function f() returns int as $tag$ begin; select ';'; end; $tag$ language plpgsql", 1],
      [`select 'a;b', "c;d"`, 2],
    ]);
    expect(statements[0]!.code).not.toContain('begin');
    expect(statements[1]!.code).toContain('"c;d"');
    expect(statements[1]!.code).not.toContain('a;b');
  });

  it('gives each statement the line it starts on, after any comment before it', () => {
    expect(splitSqlStatements('select 1;\n-- a comment\n/* another\n */\nselect 2;').map((s) => s.line)).toEqual([1, 5]);
  });
});

describe('check c with --db, on the demo stack', () => {
  let fx: Fixture;
  let findings: Finding[];
  let withRepo: Finding[];
  let repoAlone: Finding[];

  beforeAll(async () => {
    fx = await openFixture();
    const s = fx.schema;
    // A definer granted to authenticated, never revoked from public: anon executes it through PUBLIC.
    await fx.sql(`
      create function ${s}.get_report(p_id uuid) returns int language plpgsql security definer set search_path = ''
      as $$ begin perform p_id; return 1; end; $$;
      grant execute on function ${s}.get_report(uuid) to authenticated;
    `);
    findings = await functionsCheck.run(fx.context());

    // A repo whose migrations leave a definer in the same exposed schema open to PUBLIC.
    const root = await tempDir();
    await writeFiles(root, {
      [`supabase/migrations/${FIRST}`]: `create function ${s}.repo_only_report() returns int security definer language sql as $$ select 1 $$;\n`,
    });
    withRepo = await functionsCheck.run({ ...fx.context(), repoPath: root });
    repoAlone = await functionsCheck.run({ repoPath: root, exposedSchemas: [s] });
  });

  afterAll(async () => {
    await fx?.close();
  });

  // Other test files run at the same time, and their fixtures' missing search_path is reported in
  // any schema, so only this file's schema is compared.
  it('reports a definer granted to authenticated with no revoke from public as critical, as anon can execute it', () => {
    const found = inSchema(findings, fx.schema);
    expect(found.map((f) => [f.severity, f.location])).toEqual([['critical', { object: `${fx.schema}.get_report(uuid)` }]]);
    expect(found[0]!.title).toBe(`Function ${fx.schema}.get_report(uuid) runs with its owner's rights and anyone can call it`);
  });

  it('does not read the migrations, even when they leave a definer open', () => {
    expect(repoAlone.map((f) => f.location)).toEqual([{ file: `supabase/migrations/${FIRST}`, line: 1 }]);
    expect(withRepo.filter((f) => 'file' in f.location)).toEqual([]);
    expect(inSchema(withRepo, fx.schema)).toEqual(inSchema(findings, fx.schema));
  });
});
