import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { functionsCheck } from '../src/checks/functions.ts';
import { NO_DB } from '../src/checks/rls.ts';
import { splitSqlStatements } from '../src/checks/sql-statements.ts';
import type { Finding } from '../src/findings.ts';
import type { Fixture } from './database.ts';
import { inSchema, openFixture, randomName } from './database.ts';
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

  it('still reports it when a later migration revokes it from public only, as anon has its own grant on Supabase', async () => {
    const findings = await audit({ [FIRST]: REPORTS, [LATER]: 'revoke execute on function public.get_report(uuid) from public;\n' });
    expect(findings.map((f) => [f.severity, f.location])).toEqual([['high', { file: `supabase/migrations/${FIRST}`, line: lineOf(REPORTS, 'create function') }]]);
    expect(findings[0]!.why).toContain('The migrations revoke EXECUTE on it from PUBLIC but not from anon.');
  });

  it('reports nothing when a later migration revokes it from public and anon', async () => {
    expect(await audit({ [FIRST]: REPORTS, [LATER]: 'revoke execute on function public.get_report(uuid) from public, anon;\n' })).toEqual([]);
  });

  it('reports nothing when public and anon are revoked in separate statements in different migrations', async () => {
    expect(
      await audit({
        [FIRST]: REPORTS,
        [LATER]: 'revoke execute on function public.get_report(uuid) from public;\n',
        '20260103000000_anon.sql': 'revoke execute on function public.get_report(uuid) from anon;\n',
      }),
    ).toEqual([]);
  });

  it('counts public and anon revoked by different forms', async () => {
    const defaults = 'alter default privileges revoke execute on functions from public;\n';
    expect(await audit({ [FIRST]: defaults + REPORTS, [LATER]: 'revoke execute on function public.get_report(uuid) from anon;\n' })).toEqual([]);
    expect(await audit({ [FIRST]: REPORTS, [LATER]: 'revoke execute on function public.get_report from public;\nrevoke execute on all functions in schema public from anon;\n' })).toEqual([]);
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

  it('counts alter default privileges revoking from public and anon only when it comes before the create', async () => {
    // PUBLIC's default is global and anon's is Supabase's in public, so each needs its own form.
    const defaults =
      'alter default privileges revoke execute on functions from public;\nalter default privileges in schema public revoke execute on functions from anon;\n';
    expect(await audit({ [FIRST]: defaults + REPORTS })).toEqual([]);
    expect(await audit({ [FIRST]: REPORTS, [LATER]: defaults })).toHaveLength(1);
    // In public only, it leaves PUBLIC's global default in place.
    expect(await audit({ [FIRST]: `alter default privileges in schema public revoke execute on functions from public, anon;\n${REPORTS}` })).toHaveLength(1);
    // From public alone, anon keeps its own grant.
    expect(await audit({ [FIRST]: `alter default privileges in schema public revoke execute on functions from public;\n${REPORTS}` })).toHaveLength(1);
    // With no `in schema`, it leaves anon's grant in public in place.
    expect(await audit({ [FIRST]: `alter default privileges for role postgres revoke execute on functions from public, anon;\n${REPORTS}` })).toHaveLength(1);
    // In another schema only, it does not cover public.
    expect(await audit({ [FIRST]: `alter default privileges in schema private revoke execute on functions from public, anon;\n${REPORTS}` })).toHaveLength(1);
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
    expect(await audit({ [FIRST]: create, [LATER]: 'revoke execute on function get_report(uuid) from public, anon;\n' })).toEqual([]);
    expect((await audit({ [FIRST]: 'create function get_report() returns int security definer language sql as $$ select 1 $$;\n' })).map((f) => f.title)).toEqual([
      "Function public.get_report runs with its owner's rights and the migrations let anyone call it",
    ]);
  });

  it('judges each overload of one name on its own, naming its own signature in the fix', async () => {
    const overloads = `${REPORTS}create function public.get_report(p_id uuid, p_limit int default 10) returns int security definer language sql as $$ select 1 $$;\n`;
    const findings = await audit({ [FIRST]: overloads });
    expect(findings.map((f) => f.fix.snippet!.code.split('\n')[0])).toEqual([
      'revoke execute on function public.get_report(p_id uuid) from public, anon;',
      'revoke execute on function public.get_report(p_id uuid, p_limit int) from public, anon;',
    ]);
    const rest = await audit({ [FIRST]: overloads, [LATER]: 'revoke execute on function public.get_report(uuid) from public, anon;\n' });
    expect(rest).toHaveLength(1);
    expect(rest[0]!.fix.snippet!.code).toContain('public.get_report(p_id uuid, p_limit int) from public, anon;');
  });

  it('applies a revoke or drop with no argument list to the one overload of that name, and to none when there are several', async () => {
    const overloads = `${REPORTS}create function public.get_report(p_id uuid, p_limit int default 10) returns int security definer language sql as $$ select 1 $$;\n`;
    expect(await audit({ [FIRST]: overloads, [LATER]: 'revoke execute on function public.get_report from public, anon;\n' })).toHaveLength(2);
    expect(await audit({ [FIRST]: overloads, [LATER]: 'drop function public.get_report;\n' })).toHaveLength(2);
    // Once one is dropped, the name resolves to the other.
    expect(
      await audit({ [FIRST]: overloads, [LATER]: 'drop function public.get_report(uuid);\nrevoke execute on function public.get_report from public, anon;\n' }),
    ).toEqual([]);
  });

  it('matches a signature by its argument types, whatever names, modes and aliases it is written with', async () => {
    const create =
      'create function public.f(in p_id integer, p_at timestamptz, out total bigint, p_tags varchar(20)[]) security definer language sql as $$ select 1::bigint $$;\n';
    expect(
      await audit({ [FIRST]: create, [LATER]: 'revoke execute on function public.f(int4, timestamp with time zone, character varying[]) from public, anon;\n' }),
    ).toEqual([]);
    expect(await audit({ [FIRST]: create, [LATER]: 'revoke execute on function public.f(int, timestamp, text[]) from public, anon;\n' })).toHaveLength(1);
  });

  it('reports nothing when the repo has no migrations folder', async () => {
    expect(await functionsCheck.run({ repoPath: await tempDir(), exposedSchemas: ['public'] })).toEqual([]);
  });

  it("is named in check a's entry for an audit without --db, which says the rest of check c needs --db", () => {
    expect(NO_DB.why).toContain(
      'From the migrations alone, check c still flags SECURITY DEFINER functions the migrations leave executable by PUBLIC or anon; the rest of check c, and checks a, b and k, need --db.',
    );
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

// Migrations on which check c without --db must reach the verdict the database reaches: in the
// repo they are written for public, and on the demo stack each runs in a schema of its own, as a
// role of its own, so that its default privileges change nothing another test sees.
const definer = (s: string, args: string) =>
  `create function ${s}.f(${args}) returns int language sql security definer set search_path = '' as $$ select 1 $$;\n`;

const VERDICTS: { name: string; migrations: (s: string) => string; reported: string[] }[] = [
  {
    name: 'per-schema default revokes from public and anon leave PUBLIC its global default',
    migrations: (s) =>
      `alter default privileges in schema ${s} revoke execute on functions from public;\nalter default privileges in schema ${s} revoke execute on functions from anon;\n${definer(s, '')}`,
    reported: ['f()'],
  },
  {
    name: "global default revokes from public and anon leave anon Supabase's per-schema grant",
    migrations: (s) =>
      `alter default privileges revoke execute on functions from public;\nalter default privileges revoke execute on functions from anon;\n${definer(s, '')}`,
    reported: ['f()'],
  },
  {
    name: 'a global default revoke from public and a per-schema one from anon cover both',
    migrations: (s) =>
      `alter default privileges revoke execute on functions from public;\nalter default privileges in schema ${s} revoke execute on functions from anon;\n${definer(s, '')}`,
    reported: [],
  },
  {
    name: 'a revoke on one overload leaves the other open',
    migrations: (s) => `${definer(s, 'integer')}${definer(s, 'text')}revoke execute on function ${s}.f(int) from public, anon;\n`,
    reported: ['f(text)'],
  },
  {
    name: 'an invoker overload created later does not hide a definer one',
    migrations: (s) => `${definer(s, 'integer')}${definer(s, 'text').replace('security definer', 'security invoker')}`,
    reported: ['f(integer)'],
  },
  {
    name: 'dropping one overload leaves the other',
    migrations: (s) => `${definer(s, 'integer')}${definer(s, 'text')}drop function ${s}.f(int);\n`,
    reported: ['f(text)'],
  },
  {
    name: 'a revoke before a drop and a new create does not cover the new function',
    migrations: (s) =>
      `${definer(s, 'integer')}revoke execute on function ${s}.f(int) from public, anon;\ndrop function ${s}.f(int);\n${definer(s, 'integer')}`,
    reported: ['f(integer)'],
  },
  {
    name: 'a revoke before create or replace still covers the function',
    migrations: (s) =>
      `${definer(s, 'integer')}revoke execute on function ${s}.f(int) from public, anon;\n${definer(s, 'integer').replace('create function', 'create or replace function')}`,
    reported: [],
  },
];

describe('check c without --db reaches the verdict of the database', () => {
  it.each(VERDICTS)('without --db: $name', async ({ migrations, reported }) => {
    const findings = await audit({ [FIRST]: migrations('public') });
    // Each finding's fix names the exact signature of its overload.
    expect(findings.map((f) => /^revoke execute on function public\.(.+) from public, anon;$/m.exec(f.fix.snippet!.code)?.[1])).toEqual(reported);
  });
});

describe('check c with --db on the same migrations, on the demo stack', () => {
  let fx: Fixture;
  const roles: string[] = [];
  const schemas: string[] = [];
  let findings: Finding[];

  beforeAll(async () => {
    fx = await openFixture();
    // Supabase's own default privileges for functions postgres creates in public, which each
    // fixture role gets in its own schema.
    const { rows } = await fx.sql(`
      select string_agg(case when a.grantee = 0 then 'public' else quote_ident(pg_get_userbyid(a.grantee)) end, ', ') as grantees
      from pg_default_acl d, aclexplode(d.defaclacl) a
      where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace
        and d.defaclobjtype = 'f' and a.privilege_type = 'EXECUTE'`);
    const grantees = rows[0].grantees as string;
    expect(grantees.split(', ')).toContain('anon');
    for (const { migrations } of VERDICTS) {
      const role = randomName('test_role');
      roles.push(role);
      const schema = schemas.length === 0 ? fx.schema : await fx.newSchema();
      schemas.push(schema);
      await fx.sql(`create role ${role} nologin; grant ${role} to postgres; grant usage, create on schema ${schema} to ${role};`);
      await fx.sql(`alter default privileges for role ${role} in schema ${schema} grant execute on functions to ${grantees}`);
      await fx.sql(`set role ${role}`);
      try {
        await fx.sql(migrations(schema));
      } finally {
        await fx.sql('reset role');
      }
    }
    findings = await functionsCheck.run(fx.context(schemas));
  });

  afterAll(async () => {
    try {
      for (const role of roles) await fx?.sql(`drop owned by ${role}; drop role ${role};`);
    } finally {
      await fx?.close();
    }
  });

  it.each(VERDICTS.map((verdict, i) => ({ ...verdict, i })))('with --db: $name', ({ reported, i }) => {
    const schema = schemas[i]!;
    // The finding that anon can execute it; the one for authenticated, which Supabase's default
    // in public also grants, is another matter.
    const anon = inSchema(findings, schema).filter((f) => f.severity === 'critical');
    expect(anon.map((f) => ('object' in f.location ? f.location.object.slice(schema.length + 1) : ''))).toEqual(reported);
  });
});
