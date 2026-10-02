// Check a: a table without row level security. Every ordinary or partitioned table in an exposed
// schema whose RLS is off is critical. Views, materialized views and foreign tables are not part of
// this check. Without --db, checks a, b and c run no query, and this check alone reports that
// they did not run, as one manual entry.

import { catalogFor } from '../catalog.ts';
import type { TableRow } from '../catalog.ts';
import type { Finding } from '../findings.ts';
import type { Check } from './index.ts';
import { qualified } from './sql.ts';

export const rlsCheck: Check = {
  id: 'a',
  async run(context) {
    const catalog = catalogFor(context);
    if (!catalog) return [NO_DB];
    return (await catalog).tables.filter((table) => !table.rls).map(rlsOff);
  },
};

function rlsOff(table: TableRow): Finding {
  const name = `${table.schema}.${table.name}`;
  const sql = qualified(table.schema, table.name);
  return {
    check: 'a',
    severity: 'critical',
    title: `Table ${name} has row level security off`,
    location: { object: name },
    why: `The ${table.schema} schema is exposed through the Data API, and this table has row level security off, so no per-row rule protects it. With Supabase's default grants, anyone who has your anon key, which ships inside your app to every visitor, can read, change and delete every row of it.`,
    fix: {
      text: 'Turn row level security on, together with the policies that allow exactly the access the app needs. To write them, answer one question for each kind of access (read, add, change, delete): who should be allowed, anyone, any signed-in user, or only the user a row belongs to?',
      snippet: {
        language: 'sql',
        code: [
          `alter table ${sql} enable row level security;`,
          '',
          '-- Then one policy per kind of access. For example, signed-in users reading only their own',
          '-- rows (replace user_id with the column that holds the owner):',
          `-- create policy "Users read their own rows" on ${sql}`,
          '--   for select to authenticated using ((select auth.uid()) = user_id);',
          '',
        ].join('\n'),
      },
    },
    checkBefore:
      "Enabling row level security with no policy blocks every read and write by anyone but the table's owner, so the parts of the app that use this table break until its policies exist. Write the policies first and apply them in the same migration as the alter table. Code running on a server with the service-role key is not affected.",
  };
}

export const NO_DB: Finding = {
  check: 'a',
  kind: 'manual',
  title: 'The database checks did not run',
  location: { object: 'database (no --db given)' },
  why: "Checks a, b and c look for tables without row level security, policies that let anyone in, and functions anyone can call. They read the live database's catalogs, and this audit ran without --db, so it cannot say whether any of those problems exist.",
  fix: {
    text: 'Create the audit role with the SQL that role-sql prints, set its password, and run the audit again with --db and a connection string for that role.',
    snippet: {
      language: 'sh',
      code: [
        'npm run --silent role-sql > role.sql   # apply it as postgres, then set the password',
        'npm run audit -- <path> --db "postgresql://supabase_rescue_audit:<password>@<host>:5432/postgres"',
        '',
      ].join('\n'),
    },
  },
  checkBefore:
    "That you use the role from role-sql rather than postgres. It is given no access to any table, view or sequence, so it cannot read or change a row directly. Read-only is only the default for its sessions, which a session can turn off; the tool itself always opens a read-only transaction and runs only catalog queries. Like every role, it can call any function that PUBLIC may execute, and a SECURITY DEFINER function runs with its owner's rights, so it can read or change data whoever calls it; check c reports these functions. So give the password only to the audit, and drop the role when the audit is done.",
};
