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
import { inSchema, openFixture, randomName, storageFixture } from './database.ts';
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

/** The statements the comment gives for removing the role, in order: the lines up to the next blank one. */
const removal = (() => {
  const lines = ROLE_SQL.split('\n');
  const start = lines.findIndex((line) => line.startsWith('-- To remove the role')) + 1;
  return lines.slice(start, lines.indexOf('', start)).map((line) => line.replace(/^--\s+/, ''));
})();

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

  it("grants only check k's read of storage.buckets and sets no password; a closing comment says how to set one", () => {
    expect(statements.match(/\bgrant\b.*/gi)).toEqual([
      'grant usage on schema storage to supabase_rescue_audit;',
      'grant select (id, name, public) on storage.buckets to supabase_rescue_audit;',
    ]);
    expect(statements.match(/\bcreate policy\b.*/gi)).toEqual([
      'create policy supabase_rescue_audit_read_buckets on storage.buckets for select to supabase_rescue_audit using (true);',
    ]);
    expect(statements).not.toMatch(/\bpassword\b/i);
    const tail = ROLE_SQL.trimEnd().split('\n').slice(-6).join('\n');
    expect(tail).toContain('\\password supabase_rescue_audit');
    expect(tail).toContain("alter role supabase_rescue_audit password '<your password>';");
  });

  it('says in its comments what the role is given, what it is not, and what Postgres does not guarantee', () => {
    expect(comments).toContain(
      'What it is not given: any access to any table, view or sequence of your app, so it cannot read or change a row of your data directly.',
    );
    expect(comments).toContain(
      "Read-only is the default for its sessions, but a session can turn that off, so it is not a guarantee. The audit tool itself always opens a read-only transaction and runs only catalog queries and check k's read of storage.buckets.",
    );
    expect(comments).toContain('Like every role, it can call any function that PUBLIC may execute');
    expect(comments).toContain(
      "A SECURITY DEFINER function runs with its owner's rights, so it can read or change data whoever calls it. The audit's check c reports these functions, and its fixes close this path.",
    );
    expect(comments).toContain('So give the password only to the audit, and drop the role when the audit is done.');
  });

  it('says in its comments that check k reads three columns of storage.buckets, and how to remove the role now', () => {
    expect(comments).toContain(
      'It is also given read access to the id, name and public columns of storage.buckets, so check k can see which buckets are public.',
    );
    expect(comments).toContain('It cannot read your stored files or their names, nor any other column of storage.buckets.');
    expect(removal).toEqual([
      'drop policy supabase_rescue_audit_read_buckets on storage.buckets;',
      'revoke all on storage.buckets from supabase_rescue_audit;',
      'revoke usage on schema storage from supabase_rescue_audit;',
      'drop role supabase_rescue_audit;',
    ]);
  });

  it('claims neither "nothing else", read-only sessions nor a read-only catalog role, here or in the README, the PRD or the manual entry', async () => {
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
      expect(flat, name).not.toMatch(/read-only catalog role/i);
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

  // After hooks run last-registered first, so this runs before the one above, whose drop role
  // would fail while the role's storage grants and policy remain. It runs the removal the
  // role-sql comment gives, which drops the role too.
  afterAll(async () => {
    for (const statement of removal) await fx?.sql(statement.replace(/^drop role /, 'drop role if exists '));
  });

  it('has the attributes role-sql sets, and no table-level grant on any table, view or sequence', async () => {
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

  it('gives the same a, b, c and k findings for the fixture schema and a fixture bucket as the superuser', async () => {
    const store = storageFixture(fx);
    const bucket = randomName('test');
    try {
      await store.add(bucket, true);
      await store.policy(`${bucket}_owner`, `for select to authenticated using (bucket_id = '${bucket}' and owner_id = (select auth.uid())::text)`);
      const repo = await tempDir();
      await writeFiles(repo, { 'supabase/config.toml': `[api]\nschemas = ["${fx.schema}"]\n` });
      const audit = async (db: string) => {
        const out = await tempDir();
        let stderr = '';
        const code = await main(['audit', repo, '--db', db, '--out', out], { stderr: (t) => (stderr += t) });
        expect(stderr).toBe('');
        expect(code).toBe(1);
        const findings: Finding[] = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8')).findings;
        return [
          ...inSchema(findings, fx.schema).filter((f) => ['a', 'b', 'c'].includes(f.check)),
          ...findings.filter((f) => f.check === 'k' && 'object' in f.location && f.location.object === `storage.buckets/${bucket}`),
        ];
      };
      const asRole = await audit(roleUrl);
      const asSuperuser = await audit(fx.url);
      expect(asRole).toEqual(asSuperuser);
      expect(asRole.map((f) => [f.check, f.severity, 'object' in f.location && f.location.object])).toEqual([
        ['a', 'critical', `${fx.schema}.bookings`],
        ['b', 'critical', `${fx.schema}.notes policy "anon insert"`],
        ['c', 'critical', `${fx.schema}.open_definer()`],
        ['c', 'low', `${fx.schema}.open_invoker()`],
        ['k', 'high', `storage.buckets/${bucket}`],
      ]);
    } finally {
      await store.remove();
    }
  });

  it('has exactly one column-level grant: select on the id, name and public of storage.buckets', async () => {
    const { rows } = await fx.sql(
      `select table_schema, table_name, column_name, privilege_type from information_schema.column_privileges where grantee = '${AUDIT_ROLE}' order by column_name`,
    );
    expect(rows).toEqual(
      ['id', 'name', 'public'].map((column_name) => ({ table_schema: 'storage', table_name: 'buckets', column_name, privilege_type: 'SELECT' })),
    );
  });

  it('sees the same buckets as the superuser, and cannot read any other column of storage.buckets or any column of storage.objects', async () => {
    const store = storageFixture(fx);
    const bucket = randomName('test');
    try {
      await store.add(bucket, false);
      // Other test files add and remove their own test_<hex> buckets meanwhile, so only this
      // file's bucket and the demo's are compared.
      const buckets = `select id, name, public from storage.buckets where id = '${bucket}' or id !~ '^test_[0-9a-f]{12}' order by id`;
      const asRole = (await role.query(buckets)).rows;
      expect(asRole).toEqual((await fx.sql(buckets)).rows);
      expect(asRole).toContainEqual({ id: bucket, name: bucket, public: false });
      expect(asRole).toContainEqual({ id: 'customer-photos', name: 'customer-photos', public: true });

      const columns = async (table: string) =>
        (await fx.sql(`select column_name from information_schema.columns where table_schema = 'storage' and table_name = '${table}'`)).rows.map(
          (r) => r.column_name as string,
        );
      const others = (await columns('buckets')).filter((c) => !['id', 'name', 'public'].includes(c));
      expect(others.length).toBeGreaterThan(0);
      for (const column of others) {
        expect(await fails(`select "${column}" from storage.buckets limit 1`), column).toBe('permission denied for table buckets');
      }
      const objectColumns = await columns('objects');
      expect(objectColumns).toContain('owner_id');
      for (const column of objectColumns) {
        expect(await fails(`select "${column}" from storage.objects limit 1`), column).toBe('permission denied for table objects');
      }
      expect(await fails('select count(*) from storage.objects')).toBe('permission denied for table objects');
    } finally {
      await store.remove();
    }
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
