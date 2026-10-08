// The database tests' connection to the local demo stack, and fixture schemas. The URL comes from
// TEST_DB_URL, else from a TEST_DB_URL= line in the gitignored .env.test at the repo root, and must
// point at 127.0.0.1 or localhost: anything else fails the test rather than skipping it. Each test
// file creates its own schemas with random names and drops them with cascade afterwards, so the
// files can run in parallel and leave nothing behind.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import pg from 'pg';
import type { CheckContext } from '../src/checks/index.ts';

const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];

/** The test database URL from the environment or .env.test's text; throws when there is none or it is not local. */
export function resolveTestDbUrl(envValue: string | undefined, envFile: string | undefined): string {
  const url = envValue || /^TEST_DB_URL=(.*)$/m.exec(envFile ?? '')?.[1]?.trim();
  if (!url) {
    throw new Error(
      'TEST_DB_URL is not set. Start the demo stack and put TEST_DB_URL=<DB_URL from npx supabase status --workdir demo -o json> in .env.test.',
    );
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('TEST_DB_URL is not a valid URL.');
  }
  if (!LOCAL_HOSTS.includes(host)) throw new Error(`TEST_DB_URL must point at 127.0.0.1 or localhost, not ${host}.`);
  return url;
}

export function testDbUrl(): string {
  let envFile: string | undefined;
  try {
    envFile = readFileSync(new URL('../.env.test', import.meta.url), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return resolveTestDbUrl(process.env.TEST_DB_URL, envFile);
}

export function randomName(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

/**
 * True when a finding's database object is one a test file made with randomName: anything in a
 * fixture schema (test_<hex>), a table in public named test_…_<hex>, as the audit role test
 * creates, or a storage bucket named test_<hex>. Test files run in parallel, so an audit of public
 * can see another file's fixtures, and buckets are global, so an audit sees every file's buckets.
 */
export function isTestFixtureObject(object: string): boolean {
  return /^(?:test_[0-9a-f]{12}\.|public\.test_[a-z_]+_[0-9a-f]{12}(?:$|[ (])|storage\.buckets\/test_[0-9a-f]{12}$)/.test(object);
}

export interface Fixture {
  url: string;
  /** The first schema, created by openFixture. */
  schema: string;
  /** A plain superuser connection, for setting fixtures up. */
  client: pg.Client;
  sql(text: string): Promise<pg.QueryResult>;
  /** Creates another schema with a random name, dropped by close() too. */
  newSchema(): Promise<string>;
  /** A fresh check context for the test database, exposing the given schemas. */
  context(exposedSchemas?: string[]): CheckContext;
  close(): Promise<void>;
}

export async function openFixture(): Promise<Fixture> {
  const url = testDbUrl();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const schemas: string[] = [];
  const newSchema = async () => {
    const name = randomName('test');
    await client.query(`create schema ${name}`);
    schemas.push(name);
    return name;
  };
  const schema = await newSchema();
  return {
    url,
    schema,
    client,
    sql: (text) => client.query(text),
    newSchema,
    context: (exposedSchemas = [schema]) => ({ repoPath: os.tmpdir(), db: url, exposedSchemas }),
    async close() {
      try {
        for (const name of schemas) await client.query(`drop schema if exists ${name} cascade`);
      } finally {
        await client.end();
      }
    },
  };
}

/**
 * Storage buckets and policies on storage.objects for one test. Buckets are global, not per
 * schema, so each test removes its own with remove() in a finally. Bucket ids are test_<hex>, and
 * every policy names its own bucket, so that no fixture changes what another test file sees.
 */
export interface StorageFixture {
  add(id: string, isPublic: boolean): Promise<void>;
  /** Creates a policy on storage.objects; `body` is everything after the policy's name and table. */
  policy(name: string, body: string): Promise<void>;
  remove(): Promise<void>;
}

export function storageFixture(fx: Fixture): StorageFixture {
  const buckets: string[] = [];
  const policies: string[] = [];
  return {
    async add(id, isPublic) {
      await fx.client.query('insert into storage.buckets (id, name, public) values ($1, $1, $2)', [id, isPublic]);
      buckets.push(id);
    },
    async policy(name, body) {
      await fx.sql(`create policy "${name}" on storage.objects ${body}`);
      policies.push(name);
    },
    async remove() {
      for (const name of policies) await fx.sql(`drop policy if exists "${name}" on storage.objects`);
      // Storage refuses a direct delete from its tables unless this is set, here only for this
      // transaction. The delete's foreign key check locks storage.objects after storage.buckets,
      // the opposite of a policy change on storage.objects in another test file, so
      // storage.objects is locked first.
      await fx.sql('begin');
      try {
        await fx.sql("set local storage.allow_delete_query = 'true'");
        await fx.sql('lock table storage.objects in row share mode');
        await fx.client.query('delete from storage.buckets where id = any($1::text[])', [buckets]);
        await fx.sql('commit');
      } catch (error) {
        await fx.sql('rollback');
        throw error;
      }
    },
  };
}

/** The findings whose location is an object in `schema`. */
export function inSchema<T extends { location: { object: string } | { file: string; line: number } }>(
  findings: readonly T[],
  schema: string,
): T[] {
  return findings.filter((f) => 'object' in f.location && f.location.object.startsWith(`${schema}.`));
}
