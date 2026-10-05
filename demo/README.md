# Juniper & Ash Hair Studio: the flawed sample app

A small booking app for a fictional hair salon, written the way a fresh Lovable project is: React, Vite, TypeScript, Tailwind with shadcn/ui, supabase-js and React Router. The audit in the root of this repo is proven against it.

**It was built deliberately insecure, then fixed.** The tag `before` carries exactly one seeded flaw for each of the audit's checks a to f, each marked in the code with a `FLAW (check x)` comment. The fix pull request repairs a to e with new migrations and code changes. The flaw comments in the migrations that were already applied stay, because an applied migration is never edited; each new migration names the flaw it fixes. Flaw f stays too: the migration that dropped `customers.notes` cannot be undone, so the fix adds a CI step that stops the next one. Check g's flaw, the checkout that trusts the booking page's price, and check h's, the AI summary anyone can call, are on `main` until the launch fixes pull request repairs them. Run the app only against the local stack. Never deploy it.

| Check | The flaw | Where | Fixed by |
|---|---|---|---|
| a | `staff_notes` has row level security off | `supabase/migrations/20260915110000_staff_notes.sql` | `supabase/migrations/20261002090000_staff_notes_rls.sql`: RLS on, staff-only policies |
| b | The booking form's anon INSERT policy on `appointments` is `with check (true)` | `supabase/migrations/20260901090000_init.sql` | `supabase/migrations/20261002090100_booking_insert_policy.sql`: visitors may add only a future booking with status `booked` |
| c | `appointments_for_phone` is SECURITY DEFINER, anon can execute it, and it has no `search_path` | `supabase/migrations/20260908100000_find_my_booking.sql` | `supabase/migrations/20261002090200_remove_find_my_booking.sql` drops it; the booking page shows a booking reference instead |
| d | The local stack's service-role key in a `supabaseAdmin` client the Customers page uses | `src/integrations/supabase/admin.ts` | The file is deleted and Customers uses the anon-key client; the key stays in the git history, so it must be rotated |
| e | `enable_confirmations = false` under `[auth.email]`, and the Reports route has no auth check | `supabase/config.toml`, `src/App.tsx` | Confirmations on; `/reports` moved inside `ProtectedRoute` |
| f | A migration drops `customers.notes` | `supabase/migrations/20260915110000_staff_notes.sql` | Not undoable; `.github/workflows/migrations-check.yml` fails a pull request that adds such a migration |
| g | The checkout trusts the price the booking page sends | `supabase/functions/create-checkout/index.ts` | the launch fixes pull request (not yet) |
| h | The Reports page's AI summary function can be called by anyone and bills the salon's OpenAI account | `supabase/functions/summarise-weeks/index.ts`, `supabase/config.toml` | the launch fixes pull request (not yet) |

Pages: a public "Book an appointment" form that gives a booking reference (`/`), staff sign in (`/login`), Appointments (with each booking's reference), Customers, a customer's detail with their appointments, staff notes per customer, and Reports (appointments per week).

## Run it

From the repo root, start the local stack (ports are the Supabase defaults + 2000) and load the migrations and seed data:

```sh
npx supabase start --workdir demo
npx supabase db reset --workdir demo
```

Then write `demo/.env.local`, which is gitignored, from the stack's status: `VITE_SUPABASE_URL` is its `API_URL` and `VITE_SUPABASE_ANON_KEY` its `ANON_KEY`.

```sh
npx supabase status --workdir demo -o json
```

```sh
# demo/.env.local
VITE_SUPABASE_URL=http://127.0.0.1:56321
VITE_SUPABASE_ANON_KEY=<ANON_KEY from supabase status>
```

Then, in `demo/`:

```sh
npm install
npm run dev        # http://localhost:7173
npm run typecheck
npm run build
```

The three edge functions in `supabase/functions/` (`create-checkout`, `stripe-webhook` and `summarise-weeks`) need `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `OPENAI_API_KEY` only to run them, which the audit and the tests never do.

Sign in as staff with `mia@example.com` or `sam@example.com`, password `salon-demo-password` (seeded by `supabase/seed.sql`). Every name, phone number and email address in the seed data is made up.
