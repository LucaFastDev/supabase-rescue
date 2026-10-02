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
 * fixture schema (test_<hex>), or a table in public named test_…_<hex>, as the audit role test
 * creates. Test files run in parallel, so an audit of public can see another file's fixtures.
 */
export function isTestFixtureObject(object: string): boolean {
  return /^(?:test_[0-9a-f]{12}\.|public\.test_[a-z_]+_[0-9a-f]{12}(?:$|[ (]))/.test(object);
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

/** The findings whose location is an object in `schema`. */
export function inSchema<T extends { location: { object: string } | { file: string; line: number } }>(
  findings: readonly T[],
  schema: string,
): T[] {
  return findings.filter((f) => 'object' in f.location && f.location.object.startsWith(`${schema}.`));
}
