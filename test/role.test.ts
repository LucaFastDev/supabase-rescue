// The read-only role test: role-sql's output applied to the demo stack, the audit run as that role,
// and proof the role can neither write anything nor read a row of any app table.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withReadOnlyDb } from '../src/db.ts';
import type { Finding } from '../src/findings.ts';
import { main } from '../src/main.ts';
import { AUDIT_ROLE, ROLE_SQL } from '../src/rolesql.ts';
import type { Fixture } from './database.ts';
import { inSchema, openFixture, randomName } from './database.ts';
import { tempDir, writeFiles } from './repo.ts';

/** The SQL with comment lines removed. */
const statements = ROLE_SQL.split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('role-sql', () => {
  it('prints the SQL and nothing else', async () => {
    let stdout = '';
    let stderr = '';
    const code = await main(['role-sql'], { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: ROLE_SQL, stderr: '' });
  });

  it('creates the login role, guarded, with the attributes and a read-only default', () => {
    expect(statements).toMatch(/if not exists \(select 1 from pg_catalog\.pg_roles where rolname = 'supabase_rescue_audit'\) then\s+create role supabase_rescue_audit with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls;/);
    expect(statements).toContain('alter role supabase_rescue_audit set default_transaction_read_only = on;');
  });

  it('grants nothing and sets no password; a closing comment says how to set one', () => {
    expect(statements).not.toMatch(/\bgrant\b/i);
    expect(statements).not.toMatch(/\bpassword\b/i);
    const tail = ROLE_SQL.trimEnd().split('\n').slice(-6).join('\n');
    expect(tail).toContain('\\password supabase_rescue_audit');
    expect(tail).toContain("alter role supabase_rescue_audit password '<your password>';");
  });

  it('says in its comments what the role can and cannot do', () => {
    expect(ROLE_SQL).toMatch(/^-- What this role can do: /m);
    expect(ROLE_SQL).toMatch(/^-- What it cannot do: read a single row of your data, or change anything\./m);
  });
});

describe('the audit role, on the demo stack', () => {
  let fx: Fixture;
  let roleUrl: string;
  let role: pg.Client;
  let publicTable: string;

  beforeAll(async () => {
    fx = await openFixture();
    const s = fx.schema;
    publicTable = randomName('test_public');
    await fx.sql(`
      create table ${s}.bookings (id int, note text);
      insert into ${s}.bookings values (1, 'private');
      create table ${s}.notes (id int);
      alter table ${s}.notes enable row level security;
      create policy "anon insert" on ${s}.notes for insert to anon with check (true);
      create function ${s}.open_definer() returns int security definer language sql as $$ select 1 $$;
      create function ${s}.open_invoker() returns int language sql as $$ select 1 $$;
      create table public.${publicTable} (id int);
      insert into public.${publicTable} values (1);
    `);

    // Applied twice: the second run must not fail.
    await fx.sql(ROLE_SQL);
    await fx.sql(ROLE_SQL);
    const password = randomName('pw');
    await fx.sql(`alter role ${AUDIT_ROLE} password '${password}'`);
    const url = new URL(fx.url);
    url.username = AUDIT_ROLE;
    url.password = password;
    roleUrl = url.toString();
    const client = new pg.Client({ connectionString: roleUrl });
    await client.connect();
    role = client;
  });

  afterAll(async () => {
    await role?.end();
    try {
      await fx?.sql(`drop table if exists public.${publicTable}`);
      await fx?.sql(`drop role if exists ${AUDIT_ROLE}`);
    } finally {
      await fx?.close();
    }
  });

  it('has the attributes role-sql sets, and no grant on any table, view or sequence', async () => {
    const { rows } = await fx.sql(
      `select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconfig from pg_roles where rolname = '${AUDIT_ROLE}'`,
    );
    expect(rows).toEqual([
      {
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        rolconfig: ['default_transaction_read_only=on'],
      },
    ]);
    const grants = await fx.sql(
      `select count(*)::int as n from information_schema.role_table_grants where grantee = '${AUDIT_ROLE}'`,
    );
    expect(grants.rows[0].n).toBe(0);
  });

  it('gives the same a, b and c findings for the fixture schema as the superuser', async () => {
    const repo = await tempDir();
    await writeFiles(repo, { 'supabase/config.toml': `[api]\nschemas = ["${fx.schema}"]\n` });
    const audit = async (db: string) => {
      const out = await tempDir();
      let stderr = '';
      const code = await main(['audit', repo, '--db', db, '--out', out], { stderr: (t) => (stderr += t) });
      expect(stderr).toBe('');
      expect(code).toBe(1);
      const findings: Finding[] = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8')).findings;
      return inSchema(findings, fx.schema).filter((f) => ['a', 'b', 'c'].includes(f.check));
    };
    const asRole = await audit(roleUrl);
    const asSuperuser = await audit(fx.url);
    expect(asRole).toEqual(asSuperuser);
    expect(asRole.map((f) => [f.check, f.severity, 'object' in f.location && f.location.object])).toEqual([
      ['a', 'critical', `${fx.schema}.bookings`],
      ['b', 'critical', `${fx.schema}.notes policy "anon insert"`],
      ['c', 'critical', `${fx.schema}.open_definer()`],
      ['c', 'low', `${fx.schema}.open_invoker()`],
    ]);
  });

  const fails = async (sql: string) => {
    try {
      await role.query(sql);
    } catch (error) {
      return (error as Error).message;
    }
    return 'succeeded';
  };

  it('cannot read a row of the fixture table, or of any table in public', async () => {
    expect(await fails(`select * from ${fx.schema}.bookings`)).toMatch(/^permission denied/);
    const { rows } = await fx.sql(`select tablename from pg_tables where schemaname = 'public'`);
    expect(rows.map((r) => r.tablename)).toContain(publicTable);
    for (const { tablename } of rows) {
      expect(await fails(`select * from public."${tablename}" limit 1`), tablename).toMatch(/^permission denied/);
    }
  });

  it('cannot insert, update, create a table or create a function', async () => {
    for (const sql of [
      `insert into ${fx.schema}.bookings values (2, 'x')`,
      `update ${fx.schema}.bookings set note = 'x'`,
      `create table public.${randomName('nope')} (id int)`,
      `create function public.${randomName('nope')}() returns int language sql as $$ select 1 $$`,
    ]) {
      expect(await fails(sql), sql).not.toBe('succeeded');
    }
  });

  it('cannot write even in a transaction it opens read-write: it has no privilege to', async () => {
    const messages: string[] = [];
    for (const sql of [
      `insert into ${fx.schema}.bookings values (2, 'x')`,
      `update ${fx.schema}.bookings set note = 'x'`,
      `create table public.${randomName('nope')} (id int)`,
      `create function public.${randomName('nope')}() returns int language sql as $$ select 1 $$`,
    ]) {
      await role.query('begin read write');
      messages.push(await fails(sql));
      await role.query('rollback');
    }
    expect(messages).toHaveLength(4);
    for (const message of messages) expect(message).toMatch(/^permission denied for schema /);
  });

  it("cannot write through the tool's own connection, even as the superuser", async () => {
    const write = withReadOnlyDb(fx.url, (query) => query(`insert into ${fx.schema}.bookings values (3, 'x')`));
    await expect(write).rejects.toThrow(/^database: cannot execute INSERT in a read-only transaction$/);
    const { rows } = await fx.sql(`select count(*)::int as n from ${fx.schema}.bookings`);
    expect(rows[0].n).toBe(1);
  });
});
