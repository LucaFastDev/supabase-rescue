import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseError, READ_ONLY_OPTION, readOnlyUrl, safeMessage, withReadOnlyDb } from '../src/db.ts';
import { main } from '../src/main.ts';
import type { Fixture } from './database.ts';
import { openFixture, randomName, resolveTestDbUrl, testDbUrl } from './database.ts';
import { tempDir } from './repo.ts';

describe('resolveTestDbUrl', () => {
  const local = 'postgresql://postgres:postgres@127.0.0.1:56322/postgres';

  it('takes TEST_DB_URL, else the TEST_DB_URL= line of .env.test', () => {
    expect(resolveTestDbUrl(local, undefined)).toBe(local);
    expect(resolveTestDbUrl(undefined, `# demo stack\nTEST_DB_URL=${local}\n`)).toBe(local);
    expect(resolveTestDbUrl('', `TEST_DB_URL=${local.replace('127.0.0.1', 'localhost')}`)).toBe(local.replace('127.0.0.1', 'localhost'));
  });

  it('refuses when there is none', () => {
    expect(() => resolveTestDbUrl(undefined, undefined)).toThrow(/TEST_DB_URL is not set/);
    expect(() => resolveTestDbUrl(undefined, 'OTHER=1\n')).toThrow(/TEST_DB_URL is not set/);
  });

  it('refuses a host that is not 127.0.0.1 or localhost', () => {
    expect(() => resolveTestDbUrl('postgresql://postgres:pw@db.example.com:5432/postgres', undefined)).toThrow(
      /must point at 127\.0\.0\.1 or localhost, not db\.example\.com/,
    );
    expect(() => resolveTestDbUrl(undefined, 'TEST_DB_URL=postgresql://postgres:pw@10.0.0.5:5432/postgres')).toThrow(/not 10\.0\.0\.5/);
  });
});

describe('readOnlyUrl', () => {
  it('adds the read-only startup option, after any options the URL already has', () => {
    const url = new URL(readOnlyUrl('postgresql://u:p@127.0.0.1:5432/postgres?options=-c%20default_transaction_read_only%3Doff'));
    expect(url.searchParams.get('options')).toBe(`-c default_transaction_read_only=off ${READ_ONLY_OPTION}`);
    expect(new URL(readOnlyUrl('postgres://u:p@127.0.0.1/postgres')).searchParams.get('options')).toBe(READ_ONLY_OPTION);
  });

  it('refuses a string that is not a postgres URL, without repeating it', () => {
    for (const bad of ['not a url p4ssw0rd', 'mysql://u:p4ssw0rd@127.0.0.1/db']) {
      expect(() => readOnlyUrl(bad)).toThrow(DatabaseError);
      expect(() => readOnlyUrl(bad)).toThrow(/^database: --db is not a valid postgresql:\/\/ connection string$/);
    }
  });
});

describe('withReadOnlyDb, on the demo stack', () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await openFixture();
    await fx.sql(`create table ${fx.schema}.notes (id int); insert into ${fx.schema}.notes values (1);`);
  });

  afterAll(async () => {
    await fx?.close();
  });

  const withApp = (name: string) => {
    const url = new URL(fx.url);
    url.searchParams.set('application_name', name);
    return url.toString();
  };

  /** Backends still connected under this application name, waiting briefly for a closing one to go. */
  async function openBackends(name: string): Promise<number> {
    for (let i = 0; i < 40; i++) {
      const { rows } = await fx.sql(`select count(*)::int as n from pg_stat_activity where application_name = '${name}'`);
      if (rows[0].n === 0) return 0;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const { rows } = await fx.sql(`select count(*)::int as n from pg_stat_activity where application_name = '${name}'`);
    return rows[0].n;
  }

  it('runs every query in a read-only transaction, in a session that defaults to read-only', async () => {
    const settings = await withReadOnlyDb(fx.url, async (query) => ({
      transaction: (await query<{ v: string }>(`select current_setting('transaction_read_only') as v`))[0]!.v,
      session: (await query<{ v: string }>(`select current_setting('default_transaction_read_only') as v`))[0]!.v,
    }));
    expect(settings).toEqual({ transaction: 'on', session: 'on' });
  });

  it('cannot write through the read-only transaction alone, even with the session default turned off', async () => {
    const write = withReadOnlyDb(fx.url, async (query) => {
      await query('set default_transaction_read_only = off');
      return query(`insert into ${fx.schema}.notes values (2)`);
    });
    await expect(write).rejects.toThrow(/^database: cannot execute INSERT in a read-only transaction$/);
  });

  it('cannot write through the session default alone, after the transaction ends', async () => {
    const write = withReadOnlyDb(fx.url, async (query) => {
      await query('commit');
      return query(`insert into ${fx.schema}.notes values (2)`);
    });
    await expect(write).rejects.toThrow(/^database: cannot execute INSERT in a read-only transaction$/);
  });

  it('closes the connection after success, a query error and an error thrown by the caller', async () => {
    const ok = randomName('app');
    await withReadOnlyDb(withApp(ok), (query) => query('select 1'));
    expect(await openBackends(ok)).toBe(0);

    const badQuery = randomName('app');
    await expect(withReadOnlyDb(withApp(badQuery), (query) => query('select * from no_such_table'))).rejects.toThrow(DatabaseError);
    expect(await openBackends(badQuery)).toBe(0);

    const thrown = randomName('app');
    await expect(
      withReadOnlyDb(withApp(thrown), async (query) => {
        await query('select 1');
        throw new Error('boom\nsecond line');
      }),
    ).rejects.toThrow(/^database: boom$/);
    expect(await openBackends(thrown)).toBe(0);
  });
});

describe('a connection error stops the audit', () => {
  async function audit(db: string) {
    let stderr = '';
    const out = await tempDir();
    const code = await main(['audit', 'test/fixtures/empty-repo', '--db', db, '--out', out], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stderr: (text) => (stderr += text),
    });
    return { code, stderr, written: await readdir(out) };
  }

  it('exits 2 with one line that does not contain the password, for a wrong password', async () => {
    const password = `Wr0ng-${randomName('pw')}`;
    const url = new URL(testDbUrl());
    url.password = password;
    const result = await audit(url.toString());
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/^error: database: password authentication failed for user "[^"]+"\n$/);
    expect(result.stderr).not.toContain(password);
    expect(result.written).toEqual([]);
  });

  it('exits 2 with one line that does not contain the password, for an unreachable port', async () => {
    const password = `S3cret-${randomName('pw')}`;
    const result = await audit(`postgresql://postgres:${password}@127.0.0.1:1/postgres`);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/^error: database: [^\n]+\n$/);
    expect(result.stderr).not.toContain(password);
    expect(result.written).toEqual([]);
  });

  it('removes the password from a message that repeats it, written or URL-encoded, and keeps one line', () => {
    const password = 'p@ss:w/rd';
    const encoded = encodeURIComponent(password);
    const message = safeMessage(new Error(`echo ${password} and ${encoded}\nstack`), `postgresql://postgres:${encoded}@127.0.0.1:1/postgres`);
    expect(message).toBe('database: echo *** and ***');
  });
});
