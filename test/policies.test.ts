import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PolicyRow } from '../src/catalog.ts';
import { isJustTrue, openAccess, policiesCheck, policyProblem } from '../src/checks/policies.ts';
import type { Finding } from '../src/findings.ts';
import type { Fixture } from './database.ts';
import { inSchema, openFixture } from './database.ts';

describe('isJustTrue', () => {
  it.each(['true', 'TRUE', '  true  ', '(true)', '((true))', ' ( True ) ', '(\n  true\n)'])('%j is just true', (expression) => {
    expect(isJustTrue(expression)).toBe(true);
  });

  it.each(['(true) and (true)', 'true or false', '(auth.uid() = user_id)', 'not true', 'false', '', null])(
    '%j is not',
    (expression) => {
      expect(isJustTrue(expression)).toBe(false);
    },
  );
});

describe('openAccess', () => {
  it('reads INSERT from with_check only', () => {
    expect(openAccess({ cmd: 'INSERT', qual: null, with_check: 'true' })).toEqual(['insert']);
    expect(openAccess({ cmd: 'INSERT', qual: 'true', with_check: '(auth.uid() = user_id)' })).toEqual([]);
  });

  it('reads SELECT and DELETE from qual', () => {
    expect(openAccess({ cmd: 'SELECT', qual: 'true', with_check: null })).toEqual(['select']);
    expect(openAccess({ cmd: 'DELETE', qual: '(true)', with_check: null })).toEqual(['delete']);
    expect(openAccess({ cmd: 'DELETE', qual: '(auth.uid() = user_id)', with_check: 'true' })).toEqual([]);
  });

  it('reads UPDATE from both, a null with_check meaning qual', () => {
    expect(openAccess({ cmd: 'UPDATE', qual: 'true', with_check: null })).toEqual(['update']);
    expect(openAccess({ cmd: 'UPDATE', qual: '(auth.uid() = user_id)', with_check: 'true' })).toEqual(['update']);
    expect(openAccess({ cmd: 'UPDATE', qual: '(auth.uid() = user_id)', with_check: null })).toEqual([]);
  });

  it('reads ALL from qual for reads, updates and deletes, and with_check (or qual) for inserts and updates', () => {
    expect(openAccess({ cmd: 'ALL', qual: 'true', with_check: null })).toEqual(['select', 'insert', 'update', 'delete']);
    expect(openAccess({ cmd: 'ALL', qual: '(auth.uid() = user_id)', with_check: 'true' })).toEqual(['insert', 'update']);
    expect(openAccess({ cmd: 'ALL', qual: 'true', with_check: '(auth.uid() = user_id)' })).toEqual(['select', 'update', 'delete']);
  });
});

describe('policyProblem', () => {
  const policy = (fields: Partial<PolicyRow>): PolicyRow => ({
    schema: 's',
    table: 't',
    name: 'p',
    permissive: 'PERMISSIVE',
    roles: ['anon'],
    cmd: 'INSERT',
    qual: null,
    with_check: 'true',
    ...fields,
  });

  it('counts public as anon and as authenticated', () => {
    expect(policyProblem(policy({ roles: ['public'] }))?.severity).toBe('critical');
    expect(policyProblem(policy({ roles: ['public'], cmd: 'SELECT', qual: 'true', with_check: null }))?.severity).toBe('medium');
  });

  it('gives authenticated-only writes high, and authenticated reads nothing', () => {
    expect(policyProblem(policy({ roles: ['authenticated'] }))?.severity).toBe('high');
    expect(policyProblem(policy({ roles: ['authenticated'], cmd: 'SELECT', qual: 'true', with_check: null }))).toBeUndefined();
  });

  it('gives an ALL policy for anon its highest severity, critical', () => {
    expect(policyProblem(policy({ cmd: 'ALL', qual: 'true', with_check: null }))).toEqual({
      severity: 'critical',
      who: 'anon',
      access: ['select', 'insert', 'update', 'delete'],
    });
  });

  it('never reports a restrictive policy, or one for other roles', () => {
    expect(policyProblem(policy({ permissive: 'RESTRICTIVE' }))).toBeUndefined();
    expect(policyProblem(policy({ roles: ['service_role'] }))).toBeUndefined();
  });
});

describe('check b: permissive policies, on the demo stack', () => {
  let fx: Fixture;
  let hidden: string;
  let findings: Finding[];

  const at = (policy: string) =>
    findings.filter((f) => 'object' in f.location && f.location.object === `${fx.schema}.notes policy "${policy}"`);

  beforeAll(async () => {
    fx = await openFixture();
    hidden = await fx.newSchema();
    const s = fx.schema;
    await fx.sql(`
      create table ${s}.notes (id int, user_id uuid);
      alter table ${s}.notes enable row level security;
      create policy "anon insert" on ${s}.notes for insert to anon with check (true);
      create policy "anon insert parenthesised" on ${s}.notes for insert to anon with check ((true));
      create policy "anon insert guarded" on ${s}.notes for insert to anon with check (auth.uid() is not null);
      create policy "public delete" on ${s}.notes for delete to public using (true);
      create policy "anon all" on ${s}.notes for all to anon using (true);
      create policy "authenticated update" on ${s}.notes for update to authenticated using (true);
      create policy "authenticated update owner" on ${s}.notes for update to authenticated using (auth.uid() = user_id);
      create policy "authenticated update check true" on ${s}.notes for update to authenticated using (auth.uid() = user_id) with check (true);
      create policy "authenticated select" on ${s}.notes for select to authenticated using (true);
      create policy "anon select" on ${s}.notes for select to anon using (true);
      create policy "anon select owner" on ${s}.notes for select to anon using (auth.uid() = user_id);
      create policy "restrictive anon insert" on ${s}.notes as restrictive for insert to anon with check (true);
      create policy "service insert" on ${s}.notes for insert to service_role with check (true);
      create table ${hidden}.notes (id int);
      create policy "hidden anon insert" on ${hidden}.notes for insert to anon with check (true);
    `);
    findings = await policiesCheck.run(fx.context());
  });

  afterAll(async () => {
    await fx?.close();
  });

  it('reports an anon INSERT whose with_check is true as critical, one finding at schema.table policy "name"', () => {
    expect(at('anon insert')).toEqual([
      expect.objectContaining({
        check: 'b',
        severity: 'critical',
        title: `Policy "anon insert" lets anyone add any row in ${fx.schema}.notes`,
        location: { object: `${fx.schema}.notes policy "anon insert"` },
      }),
    ]);
    expect(at('anon insert')[0]!.fix.snippet!.code).toBe(
      `alter policy "anon insert" on ${fx.schema}.notes\n  to authenticated\n  with check ((select auth.uid()) = user_id);\n`,
    );
  });

  it('reports (true) written with parentheses', () => {
    expect(at('anon insert parenthesised').map((f) => f.severity)).toEqual(['critical']);
  });

  it('reports a public DELETE with true as critical', () => {
    expect(at('public delete').map((f) => f.severity)).toEqual(['critical']);
  });

  it('reports an anon ALL with true once, at critical', () => {
    expect(at('anon all').map((f) => f.severity)).toEqual(['critical']);
    expect(at('anon all')[0]!.title).toBe(
      `Policy "anon all" lets anyone read every row, add any row, change any row and delete any row in ${fx.schema}.notes`,
    );
  });

  it('reports an authenticated UPDATE with true and a null with_check as high', () => {
    expect(at('authenticated update').map((f) => f.severity)).toEqual(['high']);
    expect(at('authenticated update')[0]!.title).toBe(
      `Policy "authenticated update" lets any signed-in user change any row in ${fx.schema}.notes`,
    );
  });

  it('reports an authenticated UPDATE whose with_check alone is true as high', () => {
    expect(at('authenticated update check true').map((f) => f.severity)).toEqual(['high']);
  });

  it('reports an anon SELECT with true as medium, with a fix that says how to decide', () => {
    const [finding] = at('anon select');
    expect(finding?.severity).toBe('medium');
    expect(finding!.fix.text).toMatch(/^Decide whether this data is meant to be public/);
  });

  it('does not report guarded expressions, authenticated reads, restrictive policies or other roles', () => {
    for (const name of [
      'anon insert guarded',
      'authenticated update owner',
      'authenticated select',
      'anon select owner',
      'restrictive anon insert',
      'service insert',
    ]) {
      expect(at(name), name).toEqual([]);
    }
  });

  it('reports only those seven in the schema, and none in a schema that is not exposed', () => {
    expect(inSchema(findings, fx.schema)).toHaveLength(7);
    expect(inSchema(findings, hidden)).toEqual([]);
  });
});
