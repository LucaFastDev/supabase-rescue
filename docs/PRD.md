# supabase-rescue — PRD

Agreed with the operator on 2026-10-02 (request c7eccdd8). The scope was extended on 2026-10-04 (request bd573d60-d535-43da-936c-731b50dd870a).

## Goal

A repo, LucaFastDev/supabase-rescue (private while built; public under MIT at launch), holding three things: an audit tool that finds the database security gaps (the headline) and the launch gaps typical of apps built with Lovable, Bolt or Cursor on Supabase; a deliberately flawed sample booking app it is proven against; and a before/after case study written for clients.

## 1. The audit tool

A Node/TypeScript command-line tool, run from a checkout of this repo.

- `audit <path> [--db <connection string>]` reads a client repo checkout: migrations, `supabase/config.toml`, frontend source, committed env files, and the git history of that path for keys that were committed and later deleted. With `--db` it also reads the live database's catalogs: RLS state, policies, grants, functions; and, for check k, the `id`, `name` and `public` columns of `storage.buckets`. It never uses the service-role key or the Management API, and never writes anything.
- History is read only for the audited path: auditing `demo/` reads `demo/` and its history, never the tool's own test fixtures, which contain fake keys on purpose.
- `role-sql` prints the SQL a client runs to create a dedicated login role for the audit. The role is given no access to any table, view or sequence of the app, so it cannot read or change a row of the app's data directly, and read access to the `id`, `name` and `public` columns of `storage.buckets` (with a policy that lets only it see every bucket), so check k can see which buckets are public. Read-only is the default for its sessions, but a session can turn it off, so it is not a guarantee; the tool itself always opens a read-only transaction and runs only catalog queries and check k's read of `storage.buckets`. Like every role, it can call any function that PUBLIC may execute (Postgres's default for new functions), and a SECURITY DEFINER function runs with its owner's rights, so such a function can read or change data whoever calls it; check c reports these functions, and its fixes close this path. So the client gives the password only to the audit, and drops the role when the audit is done.
- Output: `report.md` for the client and `report.json` with the same findings for scripts. Exit code 0 when nothing is critical or high, 1 otherwise.
- The tool only suggests fixes. Each finding carries its fix there and then (the SQL or code to apply, and why) plus what to check before applying it. The tool writes no migration files and changes nothing in the audited repo or database. Delivering the fix is a separate job done by a person or a worker, as a pull request tested against the app.

### Report

Each finding has: the check (a to k), a severity (critical, high, medium, low), a title, where it is (file and line, or a database object), why it matters in plain words, the suggested fix with a SQL or code snippet, and what to check before applying it. Two kinds of entry are not severities and never change the exit code: **review** (something a static read cannot decide, for a person to look at) and **manual** (an action the tool cannot see the result of, such as rotating a key, or a setting it cannot read). The checks run a to k, in the one audit, one `report.md` and one `report.json`, under the one exit-code rule. `report.md` will open with a short plain-language summary for the owner, before the counts per severity, and then has the sections Critical, High, Medium, Low, Review and Manual actions. The summary is a change to the report renderer and has its own issue.

### Checks and severities

a. **Table without RLS.** A table in an exposed schema (`public`, or one listed in `config.toml`'s API schemas) without RLS enabled: critical. Needs `--db`.

b. **Permissive policy.** A policy granting anon insert, update or delete whose USING or WITH CHECK is just `true`: critical. The same for authenticated: high. A policy giving anon select with `true`: medium (the data may be meant to be public; the fix says how to decide). Needs `--db`.

c. **Exposed function.** A SECURITY DEFINER function in an exposed schema that anon or PUBLIC can execute: critical; that only authenticated can execute: high. A SECURITY DEFINER function in any schema without a fixed `search_path`: medium. A SECURITY INVOKER function in an exposed schema that anon or PUBLIC can execute: low (RLS still applies). One finding per function, at its highest severity, naming every problem it has. Needs `--db`.

d. **Secret in the repo.** A service-role key (a JWT whose role claim is `service_role`), an `sb_secret_` key, a database password in a connection string, or a common third-party secret (Stripe `sk_live_`/`sk_test_`, OpenAI and Anthropic keys). In frontend code or env that ships to the browser (the frontend source tree, `public/`, or a `VITE_`/`NEXT_PUBLIC_` variable): critical. In any other current file: high. Found only in the history and no longer in any current file: a **manual** action, "rotate this key; the tool cannot see whether you did", never a severity, because the history keeps it after any fix. The anon key and `sb_publishable_` keys are not findings.

e. **Auth gaps.** Email confirmation off in `config.toml`: medium. A route that renders data without an auth check: **review** (a static read of React Router routes cannot be certain). The live project's auth settings cannot be read without the Management API, so the report always lists them as **manual** checks, with where to look in the dashboard.

f. **Migration not backward-compatible.** A migration that drops a table or column, renames one, or adds NOT NULL without a default, porting the logic of ai-hq's `scripts/check-migration.mjs`: low, because an applied migration cannot be undone; the fix is a migration check in the client's CI, given as a snippet.

### Launch checks

Database security stays the headline; checks g to k extend the audit to what else a Lovable-made app needs before it goes live for real. They share the one audit, report and exit-code rule: there is no separate tool and no separate report for them. Each check's severities are set by that check's own issue and written into this subsection when the check lands; g's, h's, i's and k's are set below, and j has none because it is a manual action only.

g. **Payments (Stripe).** Three findings. An amount passed to Stripe that comes from the request body, so the browser's price is trusted (critical). A webhook handler that does not verify Stripe's signature (critical). A Stripe test publishable key (`pk_test_`) in a production env file, which is `.env.production`, `.env.prod` or one of those with a further suffix (high); `sk_test_` secret keys stay with check d. Automated, from the repo.

h. **Paid APIs anyone can run up.** One finding: an edge function that `config.toml` makes callable without sign-in (`verify_jwt = false`), that checks no signed-in user in its own code, and that calls a known paid API (AI, email or SMS providers, listed in the check): high. Whether something else limits it is for the reader to check, as the finding's "check before" says, because a static read cannot see a rate limit. Stripe is check g's. AI keys in frontend code are already check d and are not repeated here. Automated, from the repo.

i. **Auth email deliverability.** One finding: the app's code asks Supabase to send an auth email (`signUp`, `resetPasswordForEmail`, `signInWithOtp`, `resend` or `inviteUserByEmail`) and `config.toml` sets up no custom SMTP (no enabled `[auth.email.smtp]` with a host): high. A repo with no `config.toml` gets no finding. Supabase's built-in email service is for testing only, at about 2 emails an hour and only to the project's team members, so sign-up and reset emails stop reaching real users after launch. The live project's SMTP setting and the sending domain's SPF, DKIM and DMARC records are not in the repo, so every report lists them as two **manual** checks. The fix names Resend as an example and says any SMTP provider works. Automated, from the repo, plus two manual checks.

j. **Backups and plan.** The free plan keeps no backups and pauses after a week without activity. This is a manual action only: the tool cannot see the project's plan. Every report lists it as one **manual** action titled "The project is on a paid plan, with daily backups".

k. **Storage buckets.** A bucket that is public but holds private files, read from `storage.buckets` (its `id`, `name` and `public` columns) and the read policies on `storage.objects`. One finding per public bucket that has any read policy restricting who may read its files: high, because a public bucket serves every file to anyone who has its URL, whatever the policies say, so the policy only gives false confidence. A policy is open, and no finding, when it is for `public` or for both `anon` and `authenticated` and its condition is empty, `true` or only the bucket id; anything else that applies to the bucket restricts. Private buckets are no finding. An audit role that may not read `storage.buckets` gets a **review** entry saying to run the current `role-sql` again. Automated, and needs `--db`.

## 2. The sample app

A small booking app (customers, appointments, staff notes) in `demo/`, hand-written in Lovable's usual stack: React, Vite, Tailwind with shadcn/ui, supabase-js, with migrations and seed data that run on the local Supabase stack in `demo/supabase/`. It carries exactly one seeded flaw per check a to k, so the before report finds every one. For check g it has a small Stripe test-mode checkout and webhook with fake keys and no Stripe account: the audit only reads that code, and no test runs the functions, and nothing ever takes a payment.

## 3. The fix and the case study

The flawed app lands on `main` first and is tagged `before`. The fix lands as one real pull request, migrations and code, the way a client would receive it; the case study links it as the exhibit. After it, the audit finds nothing critical, high or medium.

The launch checks extend this, and the demo on `main` is already the fixed app by then, so the story holds in five steps. First, each launch check lands on `main` with its flawed demo feature, so `main` temporarily shows the new flaws. Second, one "launch fixes" pull request fixes them all, as PR #10 did for the database flaws. Third, at the end one commit carries every flaw, the new ones plus the database ones from the `before` tag, and the operator moves `before` to it. Fourth, both reports are regenerated, once and not after each check, from `before` and from `main`. Fifth, the case study keeps one before report, one after report and one table, and links both fix pull requests, PR #10 and the "launch fixes" pull request, as its two fix exhibits. The case study (`case-study/README.md`) shows the before report, the fix, the after report, and how the client works with the operator. There is one offer, analyse and fix (the operator does not sell analysis alone, decided 2026-10-04): the client sees the report, then receives the fixes as one pull request tested against their app. It needs write access to the repo (or a pull request from a fork), a way to apply migrations (the client's own pipeline or a member role in their Supabase organization), and optionally the audit role from `role-sql` (no direct access to the rows of any of the app's tables, and read access to the `id`, `name` and `public` columns of `storage.buckets`).

## Acceptance criteria

- Each check a to k has a test with a fixture that triggers it and one that does not. Check j, a manual action only, has neither, and is tested by listing its entry in every case instead.
- Against the flawed sample app (`demo/` and its local database), the audit reports exactly one finding with a severity for each check a to k, plus the review entry for the unguarded route; the before report is committed. Check j is a manual action, so it is listed under Manual actions and not counted as a finding with a severity.
- Against the fixed app: nothing critical, high or medium, no review entries, and the manual actions are only the key rotation (the key stays in the history), the fixed list of dashboard auth checks, check i's two auth email checks (custom SMTP in the dashboard, and the sending domain's SPF, DKIM and DMARC), and the backups and plan item of check j, which like the dashboard auth checks is a manual action the tool cannot see the result of; the after report is committed.
- In CI, the `role-sql` output is applied to the local stack, the audit runs with that role, and a test shows the role cannot write to or read a row of any app table directly, and that the tool's own connection cannot write even as the superuser.
- CI runs on the operator's Mac while the repo is private.

## Out of scope

Applying anything to a live database; writing fix migrations; generating or opening the fix PR in a client's repo automatically; publishing to npm; a web UI; the portfolio-site entry (a separate task once the repo is public); making the repo public and moving its CI to GitHub's runners (the operator's, at launch). Also out of scope: SEO and monitoring, and legal or GDPR wording. Later, not now: a check for queries that never page through results and silently stop at Supabase's 1,000-row default.

## Order of work

1. Scaffold: this PRD, the tool's skeleton and report format, the demo stack config.
2. Repo checks d, e and f.
3. Database checks a, b and c, `role-sql`, and the read-only role test.
4. The flawed sample app and the before report; tag `before`.
5. The fix pull request and the after report.
6. The case study.
7. Each launch check g to k, with its demo flaw, its check and its case-study row.
8. The owner summary in the renderer.
9. The "launch fixes" pull request.
10. The all-flaws commit and moving the `before` tag (the operator's).
11. Regenerating both reports.
