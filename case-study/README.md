# Case study: a booking app, before and after

Apps built fast with Lovable, Bolt or Cursor on Supabase often leave private data open to anyone: tables without access rules, secret keys in browser code, pages without a sign-in check.

I audit these apps and fix what I find. Here I audited a sample booking app with one typical flaw per check, then fixed it in one pull request.

## Before

> **Summary:** 4 critical, 0 high, 1 medium, 1 low; 1 to review, 5 manual actions.

Full report: [before/report.md](before/report.md). The fix: [pull request #10](https://github.com/LucaFastDev/supabase-rescue/pull/10).

| What was wrong | Why it matters to the business | Severity (before) | Fix |
|---|---|---|---|
| **a.** Staff notes had no access rules (row level security off). | Any visitor could read, change and delete staff notes, including allergy and payment notes. | Critical | Access rules on: only signed-in staff can use them. |
| **b.** The booking form accepted any appointment. | A visitor could add bookings in the past, or already marked confirmed or completed. | Critical | Visitors can book only a future time, with status "booked". |
| **c.** "Find my booking" skipped the access rules, and anyone could use it. | Anyone could list the appointments of any phone number. | Critical | Lookup removed. Customers get a booking reference that staff can find. |
| **d.** The service-role key, which skips every access rule, was in the browser code. | Anyone could take it and read, change and delete all data. | Critical | Code deleted. The Customers page uses the staff member's own sign-in. |
| **e.** Sign-ups did not confirm their email. | Anyone could sign up with an address they do not own. | Medium | Turned on in the settings file; turn it on in the dashboard too. |
| **e.** The Reports page had no sign-in check. | It opened for visitors who were not signed in. | Review entry, not a severity | Reports moved behind the staff sign-in. |
| **f.** A database change deleted a column. | Open tabs of the app got errors, and the column's data was lost. | Low | Cannot be undone. A new check fails pull requests with a change like it. |

## After

> **Summary:** 0 critical, 0 high, 0 medium, 1 low; 0 to review, 6 manual actions.

Nothing critical, high or medium; nothing to review. Full report: [after/report.md](after/report.md).

## Still to do

- **Rotate the service-role key.** It stays in the git history, so deleting it from the code is not enough.
- **The one low finding stays by design.** An applied database change cannot be undone. The new check stops the next one.

The other five manual actions are dashboard settings the audit cannot read.

## What access to give

- **Analyse** and **Analyse and suggest**: read access to your repo, plus optionally a database login for the audit, made with the SQL my `role-sql` command prints. It has no direct access to any table's rows.
- **Fix**: write access to your repo (or a pull request from a fork) and a way to apply database changes, either your own pipeline or a member role in your Supabase organization.

**[Hire me to audit yours]([UPWORK PROFILE LINK])**
