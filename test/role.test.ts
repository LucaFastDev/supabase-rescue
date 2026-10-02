// The read-only role test: role-sql's output applied to the demo stack, the audit run as that role,
// and proof the role cannot write to or read a row of any app table directly, and that calling a
// function does not by itself widen its access.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_DB } from '../src/checks/rls.ts';
import { withReadOnlyDb } from '../src/db.ts';
import type { Finding } from '../src/findings.ts';
import { main } from '../src/main.ts';
import { AUDIT_ROLE, ROLE_SQL } from '../src/rolesql.ts';
import type { Fixture } from './database.ts';
import { inSchema, openFixture, randomName } from './database.ts';
import { tempDir, writeFiles } from './repo.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The SQL with comment lines removed. */
const statements = ROLE_SQL.split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

/** The comments' text on one line, without the -- markers. */
const comments = ROLE_SQL.split('\n')
  .filter((line) => line.trimStart().startsWith('--'))
  .map((line) => line.replace(/^\s*--\s?/, '').trim())
  .filter(Boolean)
  .join(' ');

describe('role-sql', () => {
  it('prints the SQL, with no other output', async () => {
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

  it('says in its comments what the role is given, what it is not, and what Postgres does not guarantee', () => {
    expect(comments).toContain(
      'What it is not given: any access to any table, view or sequence, so it cannot read or change a row of your data directly.',
    );
    expect(comments).toContain(
      'Read-only is the default for its sessions, but a session can turn that off, so it is not a guarantee. The audit tool itself always opens a read-only transaction and runs only catalog queries.',
    );
    expect(comments).toContain('Like every role, it can call any function that PUBLIC may execute');
    expect(comments).toContain(
      "A SECURITY DEFINER function runs with its owner's rights, so it can read or change data whoever calls it. The audit's check c reports these functions, and its fixes close this path.",
    );
    expect(comments).toContain('So give the password only to the audit, and drop the role when the audit is done.');
  });

  it('claims neither "nothing else" nor read-only sessions, here or in the README, the PRD or the manual entry', async () => {
    const texts = {
      'role-sql': ROLE_SQL,
      'src/rolesql.ts': await readFile(path.join(root, 'src/rolesql.ts'), 'utf8'),
      'README.md': await readFile(path.join(root, 'README.md'), 'utf8'),
      'docs/PRD.md': await readFile(path.join(root, 'docs/PRD.md'), 'utf8'),
      'manual entry': JSON.stringify(NO_DB),
    };
    for (const [name, text] of Object.entries(texts)) {
      const flat = text.replace(/\s*\n\s*(--|\/\/)?\s*/g, ' ');
      expect(flat, name).not.toMatch(/nothing else/i);
      expect(flat, name).not.toMatch(/every session it opens is read-only/i);
    }
  });
});

describe('the audit role, on the demo stack', () => {
  let fx: Fixture;
  let roleUrl: string;
  let role: pg.Client;
  let publicTable: string;
  let usable: string;

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
    // A schema everyone may use, as public is, so that what stops the role below is the
    // function's or the table's own privileges, not the schema's.
    usable = await fx.newSchema();
    await fx.sql(`
      grant usage on schema ${usable} to public;
      create table ${usable}.secrets (id int);
      insert into ${usable}.secrets values (1);
      create function ${usable}.closed() returns int language sql as $$ select 1 $$;
      revoke execute on function ${usable}.closed() from public;
      create function ${usable}.reads_secrets() returns bigint security invoker language sql
        as $$ select count(*) from ${usable}.secrets $$;
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

  it('cannot read a row of the fixture table, or of any table in public, directly', async () => {
    expect(await fails(`select * from ${fx.schema}.bookings`)).toMatch(/^permission denied/);
    const { rows } = await fx.sql(`select tablename from pg_tables where schemaname = 'public'`);
    expect(rows.map((r) => r.tablename)).toContain(publicTable);
    for (const { tablename } of rows) {
      expect(await fails(`select * from public."${tablename}" limit 1`), tablename).toMatch(/^permission denied/);
    }
  });

  it('cannot insert, update, create a table or create a function directly', async () => {
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

  it('cannot call a function whose EXECUTE is revoked from PUBLIC', async () => {
    expect(await fails(`select ${usable}.closed()`)).toBe('permission denied for function closed');
  });

  it('gains no access by calling a SECURITY INVOKER function PUBLIC can execute', async () => {
    expect(await fails(`select ${usable}.reads_secrets()`)).toBe('permission denied for table secrets');
  });

  it("cannot write through the tool's own connection, even as the superuser", async () => {
    const write = withReadOnlyDb(fx.url, (query) => query(`insert into ${fx.schema}.bookings values (3, 'x')`));
    await expect(write).rejects.toThrow(/^database: cannot execute INSERT in a read-only transaction$/);
    const { rows } = await fx.sql(`select count(*)::int as n from ${fx.schema}.bookings`);
    expect(rows[0].n).toBe(1);
  });
});
