// The SQL that role-sql prints: a login role for the audit's --db option that can read the
// catalogs and nothing else. It is safe to run twice, and it sets no password.

export const AUDIT_ROLE = 'supabase_rescue_audit';

const ATTRIBUTES = 'login nosuperuser nocreatedb nocreaterole noreplication nobypassrls';

export const ROLE_SQL = `-- A login role for the supabase-rescue audit (the --db option).
--
-- What this role can do: sign in and read the database's catalogs, the built-in tables that
-- describe your schema: which tables have row level security on, their policies, your functions
-- and who may call them. That is everything the audit reads.
--
-- What it cannot do: read a single row of your data, or change anything. It is given no access to
-- any table, view or sequence. It is not a superuser, cannot create databases or roles, cannot
-- bypass row level security, and every session it opens is read-only.
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

-- Every session of this role is read-only.
alter role ${AUDIT_ROLE} set default_transaction_read_only = on;

-- No password is set here, so the role cannot sign in yet. Choose a long random password yourself
-- and keep it out of chat and email. In psql:
--   \\password ${AUDIT_ROLE}
-- or in the SQL editor:
--   alter role ${AUDIT_ROLE} password '<your password>';
-- To remove the role when the audit is done:
--   drop role ${AUDIT_ROLE};
`;
