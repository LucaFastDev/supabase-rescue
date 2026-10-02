// The SQL that role-sql prints: a login role for the audit's --db option. It is given no access to
// any table, view or sequence, and read-only is the default for its sessions. Postgres cannot make
// a login role strictly read-only, nor take PUBLIC's default rights away from one role, so the
// comments promise no more than that: a session can turn read-only off, and like every role it can
// call functions PUBLIC may execute, including SECURITY DEFINER ones that run with their owner's
// rights. It is safe to run twice, and it sets no password.

export const AUDIT_ROLE = 'supabase_rescue_audit';

const ATTRIBUTES = 'login nosuperuser nocreatedb nocreaterole noreplication nobypassrls';

export const ROLE_SQL = `-- A login role for the supabase-rescue audit (the --db option).
--
-- What this role is given: the right to sign in. Like every role, it can read the database's
-- catalogs, the built-in tables that describe your schema: which tables have row level security
-- on, their policies, your functions and who may call them. That is what the audit reads.
--
-- What it is not given: any access to any table, view or sequence, so it cannot read or change a
-- row of your data directly. It is not a superuser, cannot create databases or roles, and cannot
-- bypass row level security.
--
-- Read-only is the default for its sessions, but a session can turn that off, so it is not a
-- guarantee. The audit tool itself always opens a read-only transaction and runs only catalog
-- queries.
--
-- Like every role, it can call any function that PUBLIC may execute, which is what Postgres allows
-- for new functions unless you revoke it. A SECURITY DEFINER function runs with its owner's rights,
-- so it can read or change data whoever calls it. The audit's check c reports these functions, and
-- its fixes close this path.
--
-- So give the password only to the audit, and drop the role when the audit is done.
--
-- Run this as the postgres user, in the SQL editor or psql. Running it again is safe.

-- If the role already exists with more rights than these, this stops rather than use it.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = '${AUDIT_ROLE}') then
    create role ${AUDIT_ROLE} with ${ATTRIBUTES};
  elsif exists (
    select 1 from pg_catalog.pg_roles
    where rolname = '${AUDIT_ROLE}'
      and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)
  ) then
    raise exception '${AUDIT_ROLE} already exists with more rights than the audit needs: drop it and run this again';
  end if;
end
$$;

-- Read-only by default for this role's sessions (a session can turn it off).
alter role ${AUDIT_ROLE} set default_transaction_read_only = on;

-- No password is set here, so the role cannot sign in yet. Choose a long random password yourself
-- and keep it out of chat and email. In psql:
--   \\password ${AUDIT_ROLE}
-- or in the SQL editor:
--   alter role ${AUDIT_ROLE} password '<your password>';
-- To remove the role when the audit is done:
--   drop role ${AUDIT_ROLE};
`;
