// What checks a, b and c read from the live database: its catalogs only, never a row of an app
// table. The three queries run once per audit, in one read-only transaction (see db.ts), and the
// checks share the result, so they all see the same moment of the database.

import type { CheckContext } from './checks/index.ts';
import { withReadOnlyDb } from './db.ts';

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

export interface Catalog {
  /** Ordinary and partitioned tables in the exposed schemas. */
  tables: TableRow[];
  /** Every policy on a table in the exposed schemas. */
  policies: PolicyRow[];
  /** Every function (not procedure or aggregate) in every schema that is not skipped. */
  functions: FunctionRow[];
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
// role from role-sql does not have.
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

/** Reads the catalogs through a read-only connection to `url`. */
export async function readCatalog(url: string, exposedSchemas: readonly string[]): Promise<Catalog> {
  const params = [exposedSchemas, SKIPPED_NAMES, SKIPPED_PREFIXES];
  return withReadOnlyDb(url, async (query) => ({
    tables: await query<TableRow>(TABLES_SQL, params),
    policies: await query<PolicyRow>(POLICIES_SQL, params),
    functions: await query<FunctionRow>(FUNCTIONS_SQL, params),
  }));
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
