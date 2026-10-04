# supabase-rescue — PRD

Agreed with the operator on 2026-10-02 (request c7eccdd8).

## Goal

A repo, LucaFastDev/supabase-rescue (private while built; public under MIT at launch), holding three things: an audit tool that finds the security and production gaps typical of apps built with Lovable, Bolt or Cursor on Supabase; a deliberately flawed sample booking app it is proven against; and a before/after case study written for clients.

## 1. The audit tool

A Node/TypeScript command-line tool, run from a checkout of this repo.

- `audit <path> [--db <connection string>]` reads a client repo checkout: migrations, `supabase/config.toml`, frontend source, committed env files, and the git history of that path for keys that were committed and later deleted. With `--db` it also reads the live database's catalogs: RLS state, policies, grants, functions. It never uses the service-role key or the Management API, and never writes anything.
- History is read only for the audited path: auditing `demo/` reads `demo/` and its history, never the tool's own test fixtures, which contain fake keys on purpose.
- `role-sql` prints the SQL a client runs to create a dedicated login role for the audit. The role is given no access to any table, view or sequence, so it cannot read or change a row directly. Read-only is the default for its sessions, but a session can turn it off, so it is not a guarantee; the tool itself always opens a read-only transaction and runs only catalog queries. Like every role, it can call any function that PUBLIC may execute (Postgres's default for new functions), and a SECURITY DEFINER function runs with its owner's rights, so such a function can read or change data whoever calls it; check c reports these functions, and its fixes close this path. So the client gives the password only to the audit, and drops the role when the audit is done.
- Output: `report.md` for the client and `report.json` with the same findings for scripts. Exit code 0 when nothing is critical or high, 1 otherwise.
- The tool only suggests fixes. Each finding carries its fix there and then (the SQL or code to apply, and why) plus what to check before applying it. The tool writes no migration files and changes nothing in the audited repo or database. Delivering the fix is a separate job done by a person or a worker, as a pull request tested against the app.

### Report

Each finding has: the check (a to f), a severity (critical, high, medium, low), a title, where it is (file and line, or a database object), why it matters in plain words, the suggested fix with a SQL or code snippet, and what to check before applying it. Two kinds of entry are not severities and never change the exit code: **review** (something a static read cannot decide, for a person to look at) and **manual** (an action the tool cannot see the result of, such as rotating a key, or a setting it cannot read). `report.md` opens with counts per severity, then sections Critical, High, Medium, Low, Review and Manual actions.

### Checks and severities

a. **Table without RLS.** A table in an exposed schema (`public`, or one listed in `config.toml`'s API schemas) without RLS enabled: critical. Needs `--db`.

b. **Permissive policy.** A policy granting anon insert, update or delete whose USING or WITH CHECK is just `true`: critical. The same for authenticated: high. A policy giving anon select with `true`: medium (the data may be meant to be public; the fix says how to decide). Needs `--db`.

c. **Exposed function.** A SECURITY DEFINER function in an exposed schema that anon or PUBLIC can execute: critical; that only authenticated can execute: high. A SECURITY DEFINER function in any schema without a fixed `search_path`: medium. A SECURITY INVOKER function in an exposed schema that anon or PUBLIC can execute: low (RLS still applies). One finding per function, at its highest severity, naming every problem it has. Needs `--db`.

d. **Secret in the repo.** A service-role key (a JWT whose role claim is `service_role`), an `sb_secret_` key, a database password in a connection string, or a common third-party secret (Stripe `sk_live_`/`sk_test_`, OpenAI and Anthropic keys). In frontend code or env that ships to the browser (the frontend source tree, `public/`, or a `VITE_`/`NEXT_PUBLIC_` variable): critical. In any other current file: high. Found only in the history and no longer in any current file: a **manual** action, "rotate this key; the tool cannot see whether you did", never a severity, because the history keeps it after any fix. The anon key and `sb_publishable_` keys are not findings.

e. **Auth gaps.** Email confirmation off in `config.toml`: medium. A route that renders data without an auth check: **review** (a static read of React Router routes cannot be certain). The live project's auth settings cannot be read without the Management API, so the report always lists them as **manual** checks, with where to look in the dashboard.

f. **Migration not backward-compatible.** A migration that drops a table or column, renames one, or adds NOT NULL without a default, porting the logic of ai-hq's `scripts/check-migration.mjs`: low, because an applied migration cannot be undone; the fix is a migration check in the client's CI, given as a snippet.

## 2. The sample app

A small booking app (customers, appointments, staff notes) in `demo/`, hand-written in Lovable's usual stack: React, Vite, Tailwind with shadcn/ui, supabase-js, with migrations and seed data that run on the local Supabase stack in `demo/supabase/`. It carries exactly one seeded flaw per check a to f, so the before report finds every one.

## 3. The fix and the case study

The flawed app lands on `main` first and is tagged `before`. The fix lands as one real pull request, migrations and code, the way a client would receive it; the case study links it as the exhibit. After it, the audit finds nothing critical, high or medium. The case study (`case-study/README.md`) shows the before report, the fix, the after report, and how the client works with the operator. There is one offer, analyse and fix (the operator does not sell analysis alone, decided 2026-10-04): the client sees the report, then receives the fixes as one pull request tested against their app. It needs write access to the repo (or a pull request from a fork), a way to apply migrations (the client's own pipeline or a member role in their Supabase organization), and optionally the audit role from `role-sql` (no direct access to any table's rows).

## Acceptance criteria

- Each check a to f has a test with a fixture that triggers it and one that does not.
- Against the flawed sample app (`demo/` and its local database), the audit reports exactly one finding with a severity for each check a to f, plus the review entry for the unguarded route; the before report is committed.
- Against the fixed app: nothing critical, high or medium, no review entries, and the manual actions are only the key rotation (the key stays in the history) and the fixed list of dashboard auth checks; the after report is committed.
- In CI, the `role-sql` output is applied to the local stack, the audit runs with that role, and a test shows the role cannot write to or read a row of any app table directly, and that the tool's own connection cannot write even as the superuser.
- CI runs on the operator's Mac while the repo is private.

## Out of scope

Applying anything to a live database; writing fix migrations; generating or opening the fix PR in a client's repo automatically; publishing to npm; a web UI; the portfolio-site entry (a separate task once the repo is public); making the repo public and moving its CI to GitHub's runners (the operator's, at launch).

## Order of work

1. Scaffold: this PRD, the tool's skeleton and report format, the demo stack config.
2. Repo checks d, e and f.
3. Database checks a, b and c, `role-sql`, and the read-only role test.
4. The flawed sample app and the before report; tag `before`.
5. The fix pull request and the after report.
6. The case study.
