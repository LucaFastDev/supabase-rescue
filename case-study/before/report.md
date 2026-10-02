# Audit report

**Summary:** 4 critical, 0 high, 1 medium, 1 low; 1 to review, 5 manual actions.

Target: `demo`. Tool: supabase-rescue 0.1.0.

## Critical

### Table public.staff_notes has row level security off

- **Check:** a
- **Where:** `public.staff_notes`
- **Why:** The public schema is exposed through the Data API, and this table has row level security off, so no per-row rule protects it. With Supabase's default grants, anyone who has your anon key, which ships inside your app to every visitor, can read, change and delete every row of it.
- **Fix:** Turn row level security on, together with the policies that allow exactly the access the app needs. To write them, answer one question for each kind of access (read, add, change, delete): who should be allowed, anyone, any signed-in user, or only the user a row belongs to?

```sql
alter table public.staff_notes enable row level security;

-- Then one policy per kind of access. For example, signed-in users reading only their own
-- rows (replace user_id with the column that holds the owner):
-- create policy "Users read their own rows" on public.staff_notes
--   for select to authenticated using ((select auth.uid()) = user_id);
```

- **Check before applying:** Enabling row level security with no policy blocks every read and write by anyone but the table's owner, so the parts of the app that use this table break until its policies exist. Write the policies first and apply them in the same migration as the alter table. Code running on a server with the service-role key is not affected.

### Policy "Anyone can book an appointment" lets anyone add any row in public.appointments

- **Check:** b
- **Where:** `public.appointments policy "Anyone can book an appointment"`
- **Why:** The policy applies to anon for INSERT, and its condition is just `true`, so it allows every row: anyone who has your anon key, which ships inside your app to every visitor, can add any row in this table through the Data API.
- **Fix:** Replace `true` with a condition that says whose rows these are, and limit the policy to the roles that need it. The example limits it to signed-in users and the rows they own; replace user_id with the column that holds a row's owner.

```sql
alter policy "Anyone can book an appointment" on public.appointments
  to authenticated
  with check ((select auth.uid()) = user_id);
```

- **Check before applying:** Which parts of the app use this table, and as whom: after the change, anything that relied on the open policy, such as a sign-up or booking form for visitors, gets an error or no rows. Check the column you compare with auth.uid() exists and is filled on every row.

### Function public.appointments_for_phone(text) runs with its owner's rights and anyone can call it

- **Check:** c
- **Where:** `public.appointments_for_phone(text)`
- **Why:** 1. It is SECURITY DEFINER, so it runs with the rights of its owner, usually postgres, which row level security does not stop, and anyone who has your anon key, which ships inside your app to every visitor, can call it through the Data API. Whatever it reads or changes, any visitor can. 2. It is SECURITY DEFINER and does not set its own search_path, so the names in its body are looked up in the caller's search path. A caller who can create objects in a schema on that path can make it run their own code with the owner's rights.
- **Fix:** It has 2 problems; the SQL fixes each, in the order above.

```sql
revoke execute on function public.appointments_for_phone(text) from anon, public;
grant execute on function public.appointments_for_phone(text) to authenticated; -- only if signed-in users need it

alter function public.appointments_for_phone(text) set search_path = '';
```

- **Check before applying:** Whether the app calls this function before sign-in (supabase.rpc on a page for visitors): after the revoke those calls fail with permission denied. Revoking from public also removes signed-in users' access if it came only through public, so keep the grant to authenticated if they need it. With an empty search_path, every table, type and function the body uses must name its schema, such as public.bookings or auth.uid(). Check the body for unqualified names and run the function once after the change.

### Supabase service-role key eyJhbG…81IU in code that ships to the browser

- **Check:** d
- **Where:** `src/integrations/supabase/admin.ts:7`
- **Why:** src/integrations/supabase/admin.ts is frontend code, which ships to every visitor's browser, so anyone who opens the app can read this key. It bypasses every row level security policy: whoever holds it can read, change and delete every row in the database.
- **Fix:** Rotate the key first. In the Supabase dashboard, Project Settings, API Keys: move to the new publishable and secret keys and disable the legacy JWT-based keys, or roll the JWT secret (which replaces the anon key too). Then remove it from src/integrations/supabase/admin.ts and keep it only in server-side secrets (an edge function secret, or your host's environment variables), never in a variable the browser build reads. Deleting the line is not enough: the git history keeps the old key.
- **Check before applying:** Every place that uses this key (servers, edge functions, CI, local env files), so you can give them the new one before the old one stops working.

## High

None.

## Medium

### Email confirmation is off in config.toml

- **Check:** e
- **Where:** `supabase/config.toml:34`
- **Why:** enable_confirmations = false lets anyone sign up with an email address they do not own and use the account at once. This file configures the local stack and can be pushed to the live project with supabase config push, so it is often what production runs with too.
- **Fix:** Turn confirmations on, here and in the dashboard (see the manual check "Confirm email is on").

```toml
[auth.email]
enable_confirmations = true
```

- **Check before applying:** That your sign-up flow tells users to check their inbox before signing in. Users who signed up while it was off stay confirmed.

## Low

### Migration drops a column

- **Check:** f
- **Where:** `supabase/migrations/20260915110000_staff_notes.sql:23`
- **Why:** It drops a column. A version of the app that still reads that column, including tabs your users already have open, starts failing the moment it runs, and the data in the column is gone. The safe order is to ship a release that stops using the column, then drop it in a later migration. A migration that has been applied cannot be undone, so this is reported to catch the next one before it ships.
- **Fix:** Add a step to CI that fails a pull request whose new migrations are not backward-compatible. This one checks the migrations a pull request adds for the same patterns this check looks for, and fails too when it cannot check one.

```yaml
# .github/workflows/migration-check.yml
name: migration-check
on:
  pull_request:
    paths: ['supabase/migrations/**']
jobs:
  migrations:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: New migrations are backward-compatible
        shell: bash
        run: |
          list=$(mktemp)
          if ! git diff -z --name-only --diff-filter=A "origin/${{ github.base_ref }}...HEAD" -- 'supabase/migrations/*.sql' > "$list"; then
            echo "::error::Could not list the migrations this pull request adds."
            exit 1
          fi
          status=0
          while IFS= read -r -d '' file; do
            rc=0
            perl -e '
              my $file = shift;
              open(my $fh, "<", $file) or exit 2;
              my $hit = 0;
              while (my $line = <$fh>) {
                chomp $line;
                if ($line =~ /\bdrop\s+(column|table)\b|\brename\s+(column|to)\b|\bset\s+not\s+null\b|\balter\s+column\s+\S+\s+(set\s+data\s+)?type\b|\badd\s+column\b(?![^;,]*\b(default|generated\s+always)\b)[^;,]*\bnot\s+null\b|\btruncate\b/i) { print "$file:$.:$line\n"; $hit = 1; }
              }
              close($fh) or exit 2;
              exit $hit;
            ' -- "$file" || rc=$?
            if [ "$rc" -eq 1 ]; then
              echo "::error file=$file::$file is not backward-compatible: it drops, renames, retypes or truncates, or adds a required column without a default. Split it into backward-compatible steps."
              status=1
            elif [ "$rc" -ne 0 ]; then
              echo "::error file=$file::Could not check $file: perl exited $rc."
              status=1
            fi
          done < "$list"
          exit "$status"
```

- **Check before applying:** Whether this migration has already been applied to production. If it has, confirm the live app no longer depends on what it changed. If it has not, split it into backward-compatible steps before applying it.

## Review

### Route /reports renders data without an auth check

- **Check:** e
- **Where:** `src/App.tsx:29`
- **Why:** The page at /reports (src/pages/Reports.tsx) reads from the database, and neither the route nor the page checks that the visitor is signed in. Whether that data reaches visitors who are not signed in depends on the tables' RLS policies, which a static read cannot see, and the page may be meant to be public.
- **Fix:** If the page is for signed-in users, wrap the route in a component that sends everyone else to the sign-in page, and make sure the RLS policies on the tables it reads allow only the users who should see the rows.

```tsx
function RequireAuth({ children }: { children: JSX.Element }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
  }, []);
  if (session === undefined) return null;
  return session ? children : <Navigate to="/login" replace />;
}

<Route path="/reports" element={<RequireAuth><Page /></RequireAuth>} />
```

- **Check before applying:** Whether this page is meant to be public. A route guard only hides the page: the data itself is protected by the RLS policies on the tables it reads, so check those too.

## Manual actions

### Leaked password protection is on

- **Check:** e
- **Where:** `Supabase dashboard: Authentication > Attack Protection`
- **Why:** It refuses passwords known from public data breaches, which are the first ones attackers try. The tool cannot read the live project's auth settings without the Management API, which it never uses.
- **Fix:** In the Supabase dashboard, Authentication, Attack Protection: turn on leaked password protection.
- **Check before applying:** That your sign-up and password-reset forms show the error the API returns when a password is refused.

### Minimum password length is at least 8

- **Check:** e
- **Where:** `Supabase dashboard: Authentication > Attack Protection`
- **Why:** Short passwords fall to guessing quickly. The tool cannot read the live project's auth settings without the Management API, which it never uses.
- **Fix:** In the Supabase dashboard, Authentication, Attack Protection: set the minimum password length to 8 or more.
- **Check before applying:** That your sign-up form's own validation and message match the new minimum. Existing passwords keep working.

### Confirm email is on

- **Check:** e
- **Where:** `Supabase dashboard: Authentication > Sign In / Providers > Email`
- **Why:** Without email confirmation, anyone can sign up with an address they do not own, and the account works at once. The tool cannot read the live project's auth settings without the Management API, which it never uses.
- **Fix:** In the Supabase dashboard, Authentication, Sign In / Providers, Email: turn on Confirm email.
- **Check before applying:** That your sign-up flow tells users to check their inbox, and that the link in the email goes to an allowed redirect URL.

### Secure email change is on

- **Check:** e
- **Where:** `Supabase dashboard: Authentication > Sign In / Providers > Email`
- **Why:** Without it, a new email address needs confirming only from the new address, so someone with brief access to a signed-in session can move the account to an inbox they control. The tool cannot read the live project's auth settings without the Management API, which it never uses.
- **Fix:** In the Supabase dashboard, Authentication, Sign In / Providers, Email: turn on Secure email change.
- **Check before applying:** How users who can no longer reach their old inbox will change their address: they will need your support.

### Site URL and redirect URLs list only the app's own domains

- **Check:** e
- **Where:** `Supabase dashboard: Authentication > URL Configuration`
- **Why:** Sign-in links, password resets and OAuth sign-ins send users, with their session, to these URLs. A broad wildcard or a domain you do not control lets someone else receive a session. The tool cannot read the live project's auth settings without the Management API, which it never uses.
- **Fix:** In the Supabase dashboard, Authentication, URL Configuration: set Site URL to the app's production address, and list in Redirect URLs only the app's own domains (and localhost while developing), without broad wildcards.
- **Check before applying:** Every redirectTo and emailRedirectTo your app passes, so each one is still on the list.
