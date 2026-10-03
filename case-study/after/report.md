# Audit report

**Summary:** 0 critical, 0 high, 0 medium, 1 low; 0 to review, 6 manual actions.

Target: `demo`. Tool: supabase-rescue 0.1.0.

## Critical

None.

## High

None.

## Medium

None.

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

None.

## Manual actions

### Rotate the Supabase service-role key eyJhbG…81IU found in the git history

- **Check:** d
- **Where:** `src/integrations/supabase/admin.ts:7`
- **Why:** Rotate this key: it is in the git history at 040f259 src/integrations/supabase/admin.ts, and the history keeps it after any fix; the tool cannot see whether you rotated it.
- **Fix:** In the Supabase dashboard, Project Settings, API Keys: move to the new publishable and secret keys and disable the legacy JWT-based keys, or roll the JWT secret (which replaces the anon key too). Rewriting the history does not help: every clone and fork already has the key.
- **Check before applying:** Every place that uses this key (servers, edge functions, CI, local env files), so you can give them the new one before the old one stops working.

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
