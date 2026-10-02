# supabase-rescue

An audit tool for the security and production gaps typical of apps built with Lovable, Bolt or Cursor on Supabase, proven against a deliberately flawed sample booking app in `demo/`. The tool reads a client's repo (and, optionally, the live database's catalogs through a dedicated audit role), and writes a report of findings, each with a suggested fix and what to check before applying it. It never changes the audited repo or database. See [docs/PRD.md](docs/PRD.md) for the full plan.

The case study for clients, the sample app before and after its fix, is in [case-study/README.md](case-study/README.md).

Requires Node 22.18 or later and, for the demo stack, Docker. Run `npm install` first.

## Run the audit

```sh
npm run audit -- <path> [--db <connection string>] [--out <dir>]
```

It writes `report.md` (for the client) and `report.json` (the same findings, for scripts) to `--out`, or to the current directory. The exit code is 0 when nothing is critical or high, 1 when something is, and 2 when the audit could not run (for example, `<path>` is not a directory, or its `supabase/config.toml` is not valid TOML).

The checks that read the live database's catalogs, with `--db` (never a row of an app table; without `--db` they run no query and the report says so as a manual action):

- **a. Tables without RLS:** tables in an exposed schema (`public`, or one in `config.toml`'s `[api] schemas`) with row level security off.
- **b. Permissive policies:** policies whose condition is just `true`, for anon or signed-in users, on tables in an exposed schema.
- **c. Exposed functions:** SECURITY DEFINER functions anon or signed-in users can call, SECURITY DEFINER functions without a fixed `search_path`, and SECURITY INVOKER functions anon can call.

The checks that read only the repo:

- **d. Secrets:** service-role JWTs, `sb_secret_` keys, database passwords in connection strings, and Stripe, OpenAI and Anthropic keys in the files git tracks under `<path>`, and in the git history of `<path>` only. Secrets are shown masked.
- **e. Auth gaps:** email confirmation off in `supabase/config.toml`, React Router routes in `src/` that render data without an auth check, and the dashboard auth settings to check by hand.
- **f. Migrations:** statements in `supabase/migrations/*.sql` that are not backward-compatible with the deployed app (drops, renames, type changes, new required columns, truncates).

## The audit role (`role-sql`)

```sh
npm run --silent role-sql
```

prints the SQL that creates `supabase_rescue_audit`, a login role for `--db`. What it promises, and no more:

- It is given no access to any table, view or sequence, so it cannot read or change a row directly.
- Read-only is the default for its sessions, but a session can turn that off, so it is not a guarantee. The audit tool itself always opens a read-only transaction and runs only catalog queries.
- Like every role, it can call any function that PUBLIC may execute (Postgres's default for new functions), and a SECURITY DEFINER function runs with its owner's rights, so such a function can read or change data whoever calls it. Check c reports these functions, and its fixes close this path.
- So give the password only to the audit, and drop the role when the audit is done.

The client runs it as `postgres` (running it twice is safe), then sets a password themselves, with `\password supabase_rescue_audit` in psql; the SQL sets none. A connection or query error stops the audit with exit code 2 and a one-line error without the password.

## Start the demo stack

The flawed sample app in `demo/`, its seeded flaws and how to run it are in [demo/README.md](demo/README.md); its before report is in `case-study/before/` and its after report, for the fixed app, in [case-study/after/report.md](case-study/after/report.md).

The demo app's local Supabase stack runs on the default ports + 2000 (API on 56321, database on 56322, Studio on 56323), so it can run alongside other local stacks.

```sh
npx supabase start --workdir demo
npx supabase db reset --workdir demo   # rebuild from demo/supabase/migrations and seed.sql
npx supabase stop --workdir demo
```

## Run the tests

```sh
npm run typecheck
npm test
```

The database checks' tests use only the demo stack. Start it, then put its database URL in a gitignored `.env.test` at the repo root (or export `TEST_DB_URL`); the tests fail when there is none, or when it is not on `127.0.0.1` or `localhost`:

```sh
npx supabase status --workdir demo -o json   # TEST_DB_URL=<its DB_URL> into .env.test
```

Each test file creates its own schemas with random names and drops them afterwards.
