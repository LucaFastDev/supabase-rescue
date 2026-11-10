# supabase-rescue

Notes for a coding agent or contributor. The repo holds two things that are tested separately: an audit tool, and a deliberately flawed sample app the tool is tested against. `README.md` describes the tool, `demo/README.md` the sample app, and `docs/PRD.md` the design.

## The audit tool

- TypeScript in `src/`, run with `tsx`. The entry point is `src/cli.ts`, with one file per check in `src/checks/`. Vitest tests are in `test/`.
- Run it with `npm run audit -- <path> [--db <connection string>] [--out <dir>]`.
- It reads a repo and, with `--db`, a database's catalogs and the `id`, `name` and `public` columns of `storage.buckets`, then writes a report. It never changes what it audits.

## The sample app and its stack

- `demo/` is a separate npm package with its own `package.json`, lockfile and `.gitignore`: a booking app for a fictional hair salon (React, Vite, supabase-js).
- Its Supabase stack is in `demo/supabase/`. Run every Supabase CLI command for it from the repo root with `--workdir demo`: `npx supabase start --workdir demo`, `npx supabase db reset --workdir demo` (rebuilds the database from `demo/supabase/migrations/` and `demo/supabase/seed.sql`), `npx supabase status --workdir demo -o json` and `npx supabase stop --workdir demo`.
- The stack runs on the Supabase default ports + 2000: API on 56321, database on 56322, Studio on 56323. Its project id is fixed, so there is one such stack per machine, whichever checkout started it. After switching checkouts, reset it from the one you are working in.
- The app's dev server runs on port 7173 (strict, so a busy port is an error). It reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from the environment or from a gitignored `demo/.env.local`.
- Run the app only against the local stack. Never deploy it.
- Seeded staff sign in as `mia@example.com` or `sam@example.com`, password `salon-demo-password`.

## Conventions

- The git tag `before` marks the flawed app: one seeded flaw for each check a to i and k, each marked with a `FLAW (check x)` comment. `main` holds the fixed app. `demo/README.md` has the table of flaws and their fixes.
- A migration that has been applied is never edited. A fix is a new migration, so the `FLAW` comments in the old migrations stay. Flaw f, a migration that dropped a column, cannot be undone, so the demo has a CI step that stops the next one instead.
- The reports in `case-study/before/` and `case-study/after/` (`report.md` and `report.json`) are written by the tool, never by hand.
- `test/demo.test.ts` pins what the audit finds in the fixed app, so a change to the demo or the checks that moves a finding shows up there.

## Install and test

Run `npm install` at the root and `npm install --prefix demo` for the sample app first.

- `npm run typecheck` typechecks the tool, its tests, the e2e tests and the Playwright config.
- `npm test` runs the Vitest tests. The database checks' tests need the demo stack running and its database URL in `TEST_DB_URL`, exported or as a `TEST_DB_URL=<DB_URL>` line in a gitignored `.env.test` at the repo root. They refuse a URL that is not on `127.0.0.1` or `localhost`. Each test file creates and drops its own randomly named schemas.
- `npm run typecheck --prefix demo` and `npm run build --prefix demo` typecheck and build the sample app. Vite's warning that the bundle is over 500 kB is expected.

## The e2e suite

- `npm run test:e2e` runs the Playwright tests in `e2e/` in headless Chromium. Run it after `npx supabase db reset --workdir demo`, because the smoke test signs in as a seeded staff account and looks for seeded appointments.
- Playwright starts the demo dev server itself, and reuses one already running on its port. The port is derived from the checkout's path, so each checkout gets its own. Set `E2E_PORT` to run the suite on another port.
- It needs no `demo/.env.local`. It takes `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from the environment, or from `npx supabase status --workdir demo -o json` when they are unset, and refuses a URL that is not on `127.0.0.1` or `localhost`.
- It needs the demo's dependencies and Playwright's Chromium (`npx playwright install chromium` if the machine has none). Its output goes to `test-results/` and `playwright-report/`, both gitignored.

## Regenerate the reports

- Run both from the repo root, with the target given as the relative path `demo`, so the report holds no machine-specific path, and with the demo stack's database URL (`DB_URL` from `npx supabase status --workdir demo -o json`, `postgresql://postgres:postgres@127.0.0.1:56322/postgres` on a default stack).
- The after report: on `main`, after `npx supabase db reset --workdir demo`, run `npm run audit -- demo --db postgresql://postgres:postgres@127.0.0.1:56322/postgres --out case-study/after`.
- The before report: the same with `--out case-study/before`, from a checkout of the tag `before`, with the stack reset from that checkout's migrations. Reset it from `main` again afterwards.
