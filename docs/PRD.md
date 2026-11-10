# Design

supabase-rescue is an audit tool for apps built with Lovable, Bolt or Cursor on Supabase. It finds the database security gaps those apps typically have, and the launch gaps around them: payments, paid APIs, auth email, backups and file storage. This repo holds the tool, a deliberately flawed sample booking app the tool is tested against, and a before-and-after case study. It is released under the MIT licence.

## The tool

A Node and TypeScript command-line tool, run from a checkout of this repo.

- `audit <path> [--db <connection string>]` reads a checkout of the app's repo: migrations, `supabase/config.toml`, frontend source, committed env files, and the git history of that path for keys that were committed and later deleted. With `--db` it also reads the live database's catalogs: RLS state, policies, grants and functions, and, for check k, the `id`, `name` and `public` columns of `storage.buckets`. It never uses the service-role key or the Management API, and never writes anything.
- History is read only for the audited path. Auditing `demo/` reads `demo/` and its history, never the tool's own test fixtures, which contain fake keys on purpose.
- `role-sql` prints the SQL that creates a dedicated login role for the audit (see "The audit role" below).
- The output is `report.md` for the app's owner and `report.json`, with the same findings, for scripts.

## The report

Each finding has the check (a to k), a severity, a title, where it is (a file and line, or a database object), why it matters in plain words, a suggested fix with a SQL or code snippet, and what to check before applying it.

`report.md` opens with a short plain-language summary for the owner, then the counts per severity, then the sections Critical, High, Medium, Low, Review and Manual actions. All checks run in the one audit and write to the one `report.md` and `report.json`.

### Severities

A finding is critical, high, medium or low. Each check sets its own severities, listed under "The checks" below.

Two kinds of entry are not severities and never change the exit code:

- **Review:** something a static read cannot decide, for a person to look at.
- **Manual:** an action whose result the tool cannot see, such as rotating a key, or a setting it cannot read.

### Exit codes

- **0:** nothing critical or high.
- **1:** at least one critical or high finding.
- **2:** the audit could not run, for example because the path is not a directory, its `supabase/config.toml` is not valid TOML, or the database connection or a query failed. The error is one line and never contains the password.

## The checks

Database security is the core of the audit: checks a to c. Checks d to k cover what else such an app needs before it goes live.

**a. Table without RLS.** A table in an exposed schema (`public`, or one listed in `config.toml`'s API schemas) without row level security: critical. Needs `--db`.

**b. Permissive policy.** A policy granting anon insert, update or delete whose USING or WITH CHECK is just `true`: critical. The same for authenticated: high. A policy giving anon select with `true`: medium, because the data may be meant to be public; the fix says how to decide. Needs `--db`.

**c. Exposed function.** A SECURITY DEFINER function in an exposed schema that anon or PUBLIC can execute: critical; that only authenticated can execute: high. A SECURITY DEFINER function in any schema without a fixed `search_path`: medium. A SECURITY INVOKER function in an exposed schema that anon or PUBLIC can execute: low, because RLS still applies. There is one finding per function, at its highest severity, naming every problem it has. Without `--db`, the check reads the migrations instead and flags only SECURITY DEFINER functions in an exposed schema that they leave executable by PUBLIC or anon.

**d. Secret in the repo.** A service-role key (a JWT whose role claim is `service_role`), an `sb_secret_` key, a database password in a connection string, or a common third-party secret (Stripe `sk_live_` and `sk_test_`, OpenAI and Anthropic keys). In frontend code or env that ships to the browser (the frontend source tree, `public/`, or a `VITE_` or `NEXT_PUBLIC_` variable): critical. In any other current file: high. Found only in the history and no longer in any current file: a **manual** action, "rotate this key; the tool cannot see whether you did", never a severity, because the history keeps the key after any fix. The anon key and `sb_publishable_` keys are not findings.

**e. Auth gaps.** Email confirmation off in `config.toml`: medium. A route that renders data without an auth check: **review**, because a static read of React Router routes cannot be certain. The live project's auth settings cannot be read without the Management API, so every report lists them as **manual** checks, with where to look in the dashboard.

**f. Migration not backward-compatible.** A migration that drops, renames or retypes a table or column, truncates a table, makes an existing column required (set not null), or adds a required column without a default: low, because an applied migration cannot be undone. The fix is a migration check in the app's CI, given as a snippet.

**g. Payments (Stripe).** An amount passed to Stripe that comes from the request body, so the browser's price is trusted: critical. A webhook handler that does not verify Stripe's signature: critical. A Stripe test publishable key (`pk_test_`) in a production env file, which is `.env.production`, `.env.prod` or one of those with a further suffix: high. `sk_test_` secret keys belong to check d.

**h. Paid APIs anyone can run up.** An edge function that `config.toml` makes callable without sign-in (`verify_jwt = false`), that checks no signed-in user in its own code, and that calls a known paid API (AI, email or SMS providers, listed in the check): high. A static read cannot see a rate limit, so whether something else limits the function is for the reader to check, as the finding's "check before applying" says. Stripe belongs to check g, and AI keys in frontend code to check d.

**i. Auth email deliverability.** The app's code asks Supabase to send an auth email (`signUp`, `resetPasswordForEmail`, `signInWithOtp`, `resend` or `inviteUserByEmail`) and `config.toml` sets up no custom SMTP (no enabled `[auth.email.smtp]` with a host): high. A repo with no `config.toml` gets no finding. Supabase's built-in email service is for testing only, at about 2 emails an hour and only to the project's team members, so sign-up and reset emails stop reaching real users after launch. The fix names Resend as an example and says any SMTP provider works. The live project's SMTP setting and the sending domain's SPF, DKIM and DMARC records are not in the repo, so every report lists them as two **manual** checks.

**j. Backups and plan.** The free plan keeps no backups and pauses a project after a week without activity. The tool cannot see the project's plan, so every report lists one **manual** action, "The project is on a paid plan, with daily backups". This check has no severity.

**k. Storage buckets.** A bucket that is public but holds private files, read from `storage.buckets` (its `id`, `name` and `public` columns) and the read policies on `storage.objects`. One finding per public bucket that has any read policy restricting who may read its files: high, because a public bucket serves every file to anyone who has its URL, whatever the policies say, so the policy only gives false confidence. A policy is open, and no finding, when it is for `public` or for both `anon` and `authenticated` and its condition is empty, `true` or only the bucket id. Anything else that applies to the bucket restricts. Private buckets are no finding. An audit role that may not read `storage.buckets` gets a **review** entry saying to run the current `role-sql` again. Needs `--db`.

## The audit role

`role-sql` prints the SQL the app's owner runs, as `postgres`, to create `supabase_rescue_audit`, a login role for `--db`.

- The role is given no access to any table, view or sequence of the app, so it cannot read or change a row of the app's data directly.
- It is given read access to the `id`, `name` and `public` columns of `storage.buckets`, with a policy that lets it see every bucket, so check k can see which buckets are public.

Its limits:

- Read-only is the default for its sessions, but a session can turn that off, so it is not a guarantee. The tool itself always opens a read-only transaction and runs only catalog queries and check k's read of `storage.buckets`.
- Like every role, it can call any function that PUBLIC may execute (Postgres's default for new functions), and a SECURITY DEFINER function runs with its owner's rights, so such a function can read or change data whoever calls it. Check c reports these functions, and its fixes close this path.
- So the owner gives the password only to the audit, and drops the role when the audit is done. The SQL sets no password; the owner sets one.

## What the tool does not do

- It only suggests fixes. It writes no migration files and changes nothing in the audited repo or database. Applying a fix is a separate job, done by a person as a pull request tested against the app.
- It applies nothing to a live database, and never opens a pull request in the audited repo.
- It does not use the service-role key or the Supabase Management API, so it cannot read dashboard settings. Those appear as manual actions.
- It cannot see a rate limit, the project's plan, or whether a leaked key was rotated. A rate limit is left to the reader: check h's high finding says to check for one before applying the fix. The plan and a key found only in the history are manual actions.
- It has no web UI and is not published to npm.

## The sample app

A small booking app for a fictional hair salon (customers, appointments, staff notes, reports) in `demo/`, written in Lovable's usual stack: React, Vite, Tailwind with shadcn/ui and supabase-js, with migrations and seed data that run on a local Supabase stack in `demo/supabase/`. At the git tag `before` it carries one seeded flaw for each check with something to seed, a to i and k, so the before report finds every one. Check g's flaw is in a small Stripe test-mode checkout and webhook with fake keys and no Stripe account: the audit only reads that code, a test runs the checkout function in Node with Stripe faked, and nothing ever takes a payment.

`main` holds the fixed app. The fixes landed as pull requests of migrations and code, the way an app's owner would receive them, and the case study links them. Against the fixed app the audit finds nothing critical, high or medium, and nothing to review.

## How it is tested

- Each check a to k has a test with a fixture that triggers it and one that does not. Check j, a manual action only, is tested by listing its entry in every case instead.
- Against the flawed sample app at the tag `before` (`demo/` and its local database), the audit reports one finding with a severity for each check a to i and k, plus the review entry for the unguarded route. That report is in `case-study/before/`.
- Against the fixed app, the audit reports nothing critical, high or medium and no review entries. The manual actions are only the key rotation (the key stays in the git history), the dashboard auth checks, check i's two auth email checks, and check j's backups and plan. That report is in `case-study/after/`.
- The `role-sql` output is applied to the local demo stack, the audit runs with that role, and a test shows the role cannot write to or read a row of any app table directly, and that the tool's own connection cannot write even as the superuser.
