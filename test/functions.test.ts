import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FunctionRow } from '../src/catalog.ts';
import { functionProblems, functionsCheck } from '../src/checks/functions.ts';
import type { Finding } from '../src/findings.ts';
import type { Fixture } from './database.ts';
import { inSchema, openFixture } from './database.ts';

describe('functionProblems', () => {
  const fn = (fields: Partial<FunctionRow>): FunctionRow => ({
    schema: 's',
    name: 'f',
    args: '',
    definer: true,
    has_search_path: true,
    exposed: true,
    anon_can_execute: false,
    authenticated_can_execute: false,
    ...fields,
  });

  it('lists every problem, most severe first', () => {
    expect(functionProblems(fn({ anon_can_execute: true, authenticated_can_execute: true, has_search_path: false }))).toEqual([
      { id: 'definer-anon', severity: 'critical' },
      { id: 'no-search-path', severity: 'medium' },
    ]);
  });

  it('gives a definer only signed-in users can execute high', () => {
    expect(functionProblems(fn({ authenticated_can_execute: true }))).toEqual([{ id: 'definer-authenticated', severity: 'high' }]);
  });

  it('checks only search_path in schemas that are not exposed', () => {
    expect(functionProblems(fn({ exposed: false, anon_can_execute: true, has_search_path: false }))).toEqual([
      { id: 'no-search-path', severity: 'medium' },
    ]);
  });

  it('gives an invoker anon can execute low, and any other invoker no problem', () => {
    expect(functionProblems(fn({ definer: false, anon_can_execute: true, has_search_path: false }))).toEqual([
      { id: 'invoker-anon', severity: 'low' },
    ]);
    expect(functionProblems(fn({ definer: false, authenticated_can_execute: true, has_search_path: false }))).toEqual([]);
  });
});

describe('check c: exposed functions, on the demo stack', () => {
  let fx: Fixture;
  let hidden: string;
  let findings: Finding[];

  const at = (signature: string) =>
    findings.filter((f) => 'object' in f.location && f.location.object === `${fx.schema}.${signature}`);

  beforeAll(async () => {
    fx = await openFixture();
    hidden = await fx.newSchema();
    const s = fx.schema;
    const body = `language sql as $$ select 1 $$`;
    await fx.sql(`
      -- Critical and medium together: definer, anon can execute (through PUBLIC), no search_path.
      create function ${s}.definer_open(a integer, b text) returns int security definer ${body};

      -- Critical only: search_path set.
      create function ${s}.definer_open_pinned() returns int security definer set search_path = '' ${body};

      -- High: only authenticated can execute.
      create function ${s}.definer_signed_in() returns int security definer set search_path = public ${body};
      revoke execute on function ${s}.definer_signed_in() from public, anon;
      grant execute on function ${s}.definer_signed_in() to authenticated;

      -- Nothing: nobody but its owner can execute it, and its search_path is set.
      create function ${s}.definer_closed() returns int security definer set search_path = '' ${body};
      revoke execute on function ${s}.definer_closed() from public, anon, authenticated;

      -- Low: invoker anon can execute.
      create function ${s}.invoker_open(uuid) returns int ${body};

      -- Nothing: invoker anon cannot execute.
      create function ${s}.invoker_closed() returns int ${body};
      revoke execute on function ${s}.invoker_closed() from public, anon;

      -- Nothing: a procedure is not a function.
      create procedure ${s}.definer_procedure() security definer language sql as $$ select 1 $$;

      -- In a schema that is not exposed: medium only, for the search_path.
      create function ${hidden}.definer_hidden() returns int security definer ${body};
      create function ${hidden}.invoker_hidden() returns int ${body};
    `);
    findings = await functionsCheck.run(fx.context());
  });

  afterAll(async () => {
    await fx?.close();
  });

  it('reports a definer anon can execute with no search_path as one critical finding naming both problems', () => {
    const found = at('definer_open(integer, text)');
    expect(found).toHaveLength(1);
    const [finding] = found;
    expect(finding).toMatchObject({
      check: 'c',
      severity: 'critical',
      owner: 'Anyone on the internet can run a database function with full rights.',
      title: `Function ${fx.schema}.definer_open(integer, text) runs with its owner's rights and anyone can call it`,
      location: { object: `${fx.schema}.definer_open(integer, text)` },
    });
    expect(finding!.why).toMatch(/^1\. It is SECURITY DEFINER.*anyone who has your anon key.* 2\. It is SECURITY DEFINER and does not set its own search_path/);
    expect(finding!.fix.snippet!.code).toContain(`revoke execute on function ${fx.schema}.definer_open(integer, text) from anon, public;`);
    expect(finding!.fix.snippet!.code).toContain(`alter function ${fx.schema}.definer_open(integer, text) set search_path = '';`);
  });

  it('reports a definer anon can execute with a search_path as critical, without the search_path problem', () => {
    const [finding] = at('definer_open_pinned()');
    expect(finding?.severity).toBe('critical');
    expect(finding!.fix.snippet!.code).not.toContain('search_path');
  });

  it('reports a definer only signed-in users can execute as high', () => {
    const [finding] = at('definer_signed_in()');
    expect(finding?.severity).toBe('high');
    expect(finding!.owner).toBe('Any signed-in user can run a database function with full rights.');
    expect(finding!.fix.snippet!.code).toContain(`revoke execute on function ${fx.schema}.definer_signed_in() from authenticated;`);
  });

  it('reports an invoker anon can execute as low', () => {
    const [finding] = at('invoker_open(uuid)');
    expect(finding).toMatchObject({ severity: 'low', owner: 'Anyone can call one of your database functions.', title: `Anyone can call function ${fx.schema}.invoker_open(uuid)` });
    expect(finding!.why).toMatch(/row level security still applies/);
  });

  it('does not report a closed definer, a closed invoker or a procedure', () => {
    expect(at('definer_closed()')).toEqual([]);
    expect(at('invoker_closed()')).toEqual([]);
    expect(at('definer_procedure()')).toEqual([]);
    expect(inSchema(findings, fx.schema)).toHaveLength(4);
  });

  it('reports only the missing search_path for a definer in a schema that is not exposed, as medium', () => {
    expect(inSchema(findings, hidden).map((f) => [f.location, f.severity])).toEqual([
      [{ object: `${hidden}.definer_hidden()` }, 'medium'],
    ]);
    expect(inSchema(findings, hidden)[0]!.owner).toBe('A database function could be tricked into running the wrong code.');
  });
});
