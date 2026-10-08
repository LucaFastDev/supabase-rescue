// What checks a, b, c and k read from the live database: its catalogs, and for check k the id,
// name and public setting of each storage bucket, never a row of an app table. The queries run
// once per audit, in one read-only transaction (see db.ts), and the checks share the result, so
// they all see the same moment of the database.

import type { CheckContext } from './checks/index.ts';
import { withReadOnlyDb } from './db.ts';
import type { Query } from './db.ts';

/**
 * Schemas that Supabase and Postgres manage. Checks a, b and c never report an object in one,
 * even when config.toml exposes it: the client did not write these objects and cannot fix them.
 * A name ending in * matches every schema that starts with what comes before it (the temporary
 * schemas pg_temp_N and pg_toast_temp_N). Objects that belong to an extension are skipped too,
 * wherever they are.
 */
export const SKIPPED_SCHEMAS = [
  'pg_catalog',
  'information_schema',
  'pg_toast',
  'pg_temp_*',
  'pg_toast_temp_*',
  'auth',
  'storage',
  'realtime',
  '_realtime',
  'extensions',
  'graphql',
  'graphql_public',
  'vault',
  'pgsodium',
  'pgsodium_masks',
  'supabase_functions',
  'supabase_migrations',
  'net',
  'cron',
  'pgbouncer',
  '_analytics',
  'pgmq',
] as const;

const SKIPPED_NAMES: string[] = SKIPPED_SCHEMAS.filter((s) => !s.endsWith('*'));
const SKIPPED_PREFIXES = SKIPPED_SCHEMAS.filter((s) => s.endsWith('*')).map((s) => s.slice(0, -1));

export function isSkippedSchema(schema: string): boolean {
  return SKIPPED_NAMES.includes(schema) || SKIPPED_PREFIXES.some((prefix) => schema.startsWith(prefix));
}

export interface TableRow {
  schema: string;
  name: string;
  rls: boolean;
}

export interface PolicyRow {
  schema: string;
  table: string;
  name: string;
  permissive: 'PERMISSIVE' | 'RESTRICTIVE';
  roles: string[];
  cmd: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
  qual: string | null;
  with_check: string | null;
}

export interface FunctionRow {
  schema: string;
  name: string;
  /** The argument types, as in the function's signature. */
  args: string;
  definer: boolean;
  has_search_path: boolean;
  exposed: boolean;
  anon_can_execute: boolean;
  authenticated_can_execute: boolean;
}

export interface BucketRow {
  id: string;
  name: string;
  public: boolean;
}

export interface StoragePolicyRow {
  name: string;
  permissive: 'PERMISSIVE' | 'RESTRICTIVE';
  roles: string[];
  qual: string | null;
}

export interface Catalog {
  /** Ordinary and partitioned tables in the exposed schemas. */
  tables: TableRow[];
  /** Every policy on a table in the exposed schemas. */
  policies: PolicyRow[];
  /** Every function (not procedure or aggregate) in every schema that is not skipped. */
  functions: FunctionRow[];
  /**
   * Every storage bucket, or 'no-privilege' when the role may not read storage.buckets, as an
   * audit role made with an older role-sql may not.
   */
  buckets: BucketRow[] | 'no-privilege';
  /** The policies that govern reading storage.objects (SELECT and ALL). */
  storageReadPolicies: StoragePolicyRow[];
}

// $1: the exposed schemas. $2 and $3: the skipped schema names and prefixes.
const NOT_SKIPPED = `not (n.nspname = any($2::text[]) or exists (select 1 from unnest($3::text[]) prefix where starts_with(n.nspname, prefix)))`;
const NOT_EXTENSION_MEMBER = (catalog: string, oid: string) =>
  `not exists (select 1 from pg_catalog.pg_depend d where d.classid = '${catalog}'::regclass and d.objid = ${oid} and d.deptype = 'e')`;

const TABLES_SQL = `
select n.nspname as schema, c.relname as name, c.relrowsecurity as rls
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and n.nspname = any($1::text[])
  and ${NOT_SKIPPED}
  and ${NOT_EXTENSION_MEMBER('pg_catalog.pg_class', 'c.oid')}
order by 1, 2`;

// Joined by name rather than cast to regclass: a cast needs USAGE on the schema, which the audit
// role from role-sql has only on storage.
const POLICIES_SQL = `
select p.schemaname as schema, p.tablename as table, p.policyname as name, p.permissive,
       p.roles::text[] as roles, p.cmd, p.qual, p.with_check
from pg_catalog.pg_policies p
join pg_catalog.pg_namespace n on n.nspname = p.schemaname
join pg_catalog.pg_class c on c.relnamespace = n.oid and c.relname = p.tablename
where n.nspname = any($1::text[])
  and ${NOT_SKIPPED}
  and ${NOT_EXTENSION_MEMBER('pg_catalog.pg_class', 'c.oid')}
order by 1, 2, 3`;

const CAN_EXECUTE = (role: string) =>
  `case when exists (select 1 from pg_catalog.pg_roles where rolname = '${role}')
        then pg_catalog.has_function_privilege('${role}', p.oid, 'EXECUTE') else false end`;

const FUNCTIONS_SQL = `
select n.nspname as schema, p.proname as name, pg_catalog.oidvectortypes(p.proargtypes) as args,
       p.prosecdef as definer,
       coalesce((select bool_or(s like 'search\\_path=%') from unnest(p.proconfig) s), false) as has_search_path,
       n.nspname = any($1::text[]) as exposed,
       ${CAN_EXECUTE('anon')} as anon_can_execute,
       ${CAN_EXECUTE('authenticated')} as authenticated_can_execute
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where p.prokind = 'f'
  and ${NOT_SKIPPED}
  and ${NOT_EXTENSION_MEMBER('pg_catalog.pg_proc', 'p.oid')}
order by 1, 2, 3`;

// Not a catalog: a table of the storage schema, of which role-sql grants the audit role these
// three columns and a policy that lets it see every row.
const BUCKETS_SQL = `select id, name, public from storage.buckets order by id`;

const STORAGE_READ_POLICIES_SQL = `
select policyname as name, permissive, roles::text[] as roles, qual
from pg_catalog.pg_policies
where schemaname = 'storage' and tablename = 'objects' and cmd in ('SELECT', 'ALL')
order by policyname`;

const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * The storage buckets, or 'no-privilege' when the role may not read them. The query runs in a
 * savepoint, so that a refusal leaves the transaction usable for the other queries.
 */
async function readBuckets(query: Query): Promise<BucketRow[] | 'no-privilege'> {
  await query('savepoint storage_buckets');
  try {
    const buckets = await query<BucketRow>(BUCKETS_SQL);
    await query('release savepoint storage_buckets');
    return buckets;
  } catch (error) {
    if ((error as { code?: unknown }).code !== INSUFFICIENT_PRIVILEGE) throw error;
    await query('rollback to savepoint storage_buckets');
    return 'no-privilege';
  }
}

/** Reads the catalogs and the storage buckets through a read-only connection to `url`. */
export async function readCatalog(url: string, exposedSchemas: readonly string[]): Promise<Catalog> {
  const params = [exposedSchemas, SKIPPED_NAMES, SKIPPED_PREFIXES];
  return withReadOnlyDb(url, async (query) => {
    const tables = await query<TableRow>(TABLES_SQL, params);
    const policies = await query<PolicyRow>(POLICIES_SQL, params);
    const functions = await query<FunctionRow>(FUNCTIONS_SQL, params);
    // The policies before the buckets: pg_policies locks storage.objects to deparse them, and
    // creating or dropping a policy on storage.objects locks it and then storage.buckets. Taking
    // the two in the same order means the audit can wait for such a migration but never deadlock
    // with it, which would make one of the two fail.
    const storageReadPolicies = await query<StoragePolicyRow>(STORAGE_READ_POLICIES_SQL);
    const buckets = await readBuckets(query);
    return { tables, policies, functions, buckets, storageReadPolicies };
  });
}

const snapshots = new WeakMap<CheckContext, Promise<Catalog>>();

/**
 * The catalog for this audit, read on first use and shared by every check given the same
 * context; undefined without --db, when the database checks run no query.
 */
export function catalogFor(context: CheckContext): Promise<Catalog> | undefined {
  if (context.db === undefined) return undefined;
  let snapshot = snapshots.get(context);
  if (!snapshot) {
    snapshot = readCatalog(context.db, context.exposedSchemas);
    snapshots.set(context, snapshot);
  }
  return snapshot;
}
