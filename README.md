# supabase-rescue

An audit tool for the security and production gaps typical of apps built with Lovable, Bolt or Cursor on Supabase, proven against a deliberately flawed sample booking app in `demo/`. The tool reads a client's repo (and, optionally, the live database's catalogs through a read-only role), and writes a report of findings, each with a suggested fix and what to check before applying it. It never changes the audited repo or database. See [docs/PRD.md](docs/PRD.md) for the full plan.

Requires Node 22.18 or later and, for the demo stack, Docker. Run `npm install` first.

## Run the audit

```sh
npm run audit -- <path> [--db <connection string>] [--out <dir>]
```

It writes `report.md` (for the client) and `report.json` (the same findings, for scripts) to `--out`, or to the current directory. The exit code is 0 when nothing is critical or high, 1 when something is, and 2 when the audit could not run (for example, `<path>` is not a directory).

```sh
npm run --silent role-sql
```

prints the SQL that creates a read-only login role for `--db`. It is not implemented yet.

## Start the demo stack

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

The tests need no network and no database.
