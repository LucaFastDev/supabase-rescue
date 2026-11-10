# supabase-rescue

An audit tool for apps built with Lovable, Bolt or Cursor on Supabase: it finds tables anyone can read, secrets in the code, payments that trust the browser and other security and launch gaps, each with a suggested fix. It reads the app's repo and, optionally, the live database's catalogs through a dedicated audit role. It never changes the audited code or database.

**[The case study](case-study/README.md) shows the tool finding the sample app's critical problems, and the fix.**

The tool is tested against a deliberately flawed sample booking app in `demo/`. The design behind its checks and severities is in [docs/PRD.md](docs/PRD.md).

Requires Node 22.18 or later and, for the demo stack, Docker. Run `npm install` first.

## Run the audit

```sh
npm run audit -- <path> [--db <connection string>] [--out <dir>]
```

It writes `report.md` (for the app's owner) and `report.json` (the same findings, for scripts) to `--out`, or to the current directory. Each finding has a suggested fix and what to check before applying it. The exit code is 0 when nothing is critical or high, 1 when something is, and 2 when the audit could not run (for example, `<path>` is not a directory, or its `supabase/config.toml` is not valid TOML).

### Checks that read the repo

- **d. Secrets:** service-role JWTs, `sb_secret_` keys, database passwords in connection strings, and Stripe, OpenAI and Anthropic keys in the files git tracks under `<path>`, and in the git history of `<path>` only. Secrets are shown masked.
- **e. Auth gaps:** email confirmation off in `supabase/config.toml`, React Router routes in `src/` that render data without an auth check, and the dashboard auth settings to check by hand.
- **f. Migrations:** statements in `supabase/migrations/*.sql` that are not backward-compatible with the deployed app (drops, renames, type changes, new required columns, truncates).
- **g. Payments (Stripe):** a Stripe checkout or payment amount taken from the request body, a Stripe webhook handler that never verifies Stripe's signature, and a Stripe test publishable key in a production env file (`.env.production`, `.env.prod`), in the files git tracks under `<path>`.
- **h. Paid APIs:** an edge function that `supabase/config.toml` opens to anyone (`verify_jwt = false`), that checks no signed-in user, and that calls a paid API such as OpenAI, Anthropic, Resend or Twilio, in the files git tracks under `<path>`.
- **i. Auth email:** code that asks Supabase to send auth emails (sign-up, password reset, sign-in link, invitation) while `supabase/config.toml` sets up no SMTP server of its own, in the files git tracks under `<path>`, and, in every report, two checks by hand: custom SMTP in the dashboard, and the sending domain's SPF, DKIM and DMARC records.
- **j. Backups and plan:** always listed, in every report, as one check by hand: that the project is on a paid plan, with daily backups, because the free plan keeps no backups and pauses a project after a week without activity, and the tool cannot see which plan the project is on.

### Checks that read the live database (`--db`)

With `--db`, these checks read the live database's catalogs and, for check k, the `id`, `name` and `public` columns of `storage.buckets`, never a row of app data. Without `--db` they run no query, and the report lists them as manual actions.

- **a. Tables without RLS:** tables in an exposed schema (`public`, or one in `config.toml`'s `[api] schemas`) with row level security off.
- **b. Permissive policies:** policies whose condition is just `true`, for anon or signed-in users, on tables in an exposed schema.
- **c. Exposed functions:** SECURITY DEFINER functions anon or signed-in users can call, SECURITY DEFINER functions without a fixed `search_path`, and SECURITY INVOKER functions anon can call. Without `--db` it reads `supabase/migrations/*.sql` instead and flags only SECURITY DEFINER functions in an exposed schema that the migrations leave executable by PUBLIC or anon: not revoked from both (on Supabase, anon gets its own grant on new functions, so a revoke from PUBLIC alone is not enough), or granted to anon. The rest of check c needs `--db`, which also confirms what the live database allows.
- **k. Storage buckets:** a public storage bucket with a read policy on `storage.objects` that restricts who may read its files. A public bucket serves every file to anyone who has its URL, so the policy protects nothing.

## The audit role (`role-sql`)

```sh
npm run --silent role-sql
```

prints the SQL that creates `supabase_rescue_audit`, a login role for `--db`. What it promises, and no more:

- It is given no access to any table, view or sequence of the app, so it cannot read or change a row of the app's data directly. It is given read access to the `id`, `name` and `public` columns of `storage.buckets`, so check k can see which buckets are public, and a policy on `storage.buckets` that lets it see every bucket.
- Read-only is the default for its sessions, but a session can turn that off, so it is not a guarantee. The audit tool itself always opens a read-only transaction and runs only catalog queries and check k's read of `storage.buckets`.
- Like every role, it can call any function that PUBLIC may execute (Postgres's default for new functions), and a SECURITY DEFINER function runs with its owner's rights, so such a function can read or change data whoever calls it. Check c reports these functions, and its fixes close this path.
- So give the password only to the audit, and drop the role when the audit is done.

The app's owner runs it as `postgres` (running it twice is safe), then sets a password themselves, with `\password supabase_rescue_audit` in psql; the SQL sets none. A connection or query error stops the audit with exit code 2 and a one-line error without the password.

## Start the demo stack

The flawed sample app in `demo/`, its seeded flaws and how to run it are in [demo/README.md](demo/README.md). Its before report is in [case-study/before/report.md](case-study/before/report.md) and its after report, for the fixed app, in [case-study/after/report.md](case-study/after/report.md).

The demo app's local Supabase stack runs on the default ports + 2000 (API on 56321, database on 56322, Studio on 56323), so it can run alongside other local stacks.

```sh
npx supabase start --workdir demo
npx supabase db reset --workdir demo   # rebuild from demo/supabase/migrations and seed.sql
npx supabase stop --workdir demo
```

## Development

### Run the tests

```sh
npm run typecheck
npm test
```

The database checks' tests use only the demo stack. Start it, then put its database URL in a gitignored `.env.test` at the repo root (or export `TEST_DB_URL`). The tests fail when there is none, or when it is not on `127.0.0.1` or `localhost`:

```sh
npx supabase status --workdir demo -o json   # TEST_DB_URL=<its DB_URL> into .env.test
```

Each test file creates its own schemas with random names and drops them afterwards.

### The demo app and the browser tests

The demo app is a separate npm package. Install its dependencies, then typecheck and build it:

```sh
npm install --prefix demo
npm run typecheck --prefix demo
npm run build --prefix demo   # Vite's warning that the bundle is over 500 kB is expected
```

The browser tests in `e2e/` run the demo app in headless Chromium against the demo stack. Reset the stack first, because they sign in as a seeded staff account and look for seeded appointments:

```sh
npx playwright install chromium   # once, if this machine has no Chromium for Playwright
npx supabase db reset --workdir demo
npm run test:e2e
```

Playwright starts the demo dev server itself, and reuses one already running on its port. It takes the stack's URL and anon key from `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, or from `npx supabase status --workdir demo -o json` when they are unset, and refuses a URL that is not on `127.0.0.1` or `localhost`. The port is derived from the checkout's path, so each checkout gets its own; set `E2E_PORT` to run the suite on another port. Results go to `test-results/` and `playwright-report/`, both gitignored.

### Regenerate the case study reports

The reports in `case-study/before/` and `case-study/after/` are written by the tool, never by hand. Run them from the repo root with the target given as the relative path `demo`, so the report holds no machine-specific path, and with the demo stack's database URL (`DB_URL` from `npx supabase status --workdir demo -o json`).

The after report is regenerated on `main`:

```sh
npx supabase db reset --workdir demo
npm run audit -- demo --db postgresql://postgres:postgres@127.0.0.1:56322/postgres --out case-study/after
```

The before report is regenerated the same way with `--out case-study/before`, from a checkout of the tag `before`, with the stack reset from that checkout's migrations. Reset the stack from `main` again afterwards.

`test/demo.test.ts` pins what the audit finds in the fixed app, so a change to the demo or to the checks that moves a finding shows up there.

## License

MIT. See [LICENSE](LICENSE).

## Contact

Questions, or want a check like this on your own Supabase project? Email luca.fastdev@gmail.com.
