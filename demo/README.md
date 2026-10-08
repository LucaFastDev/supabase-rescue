# Juniper & Ash Hair Studio: the flawed sample app

A small booking app for a fictional hair salon, written the way a fresh Lovable project is: React, Vite, TypeScript, Tailwind with shadcn/ui, supabase-js and React Router. The audit in the root of this repo is proven against it.

**It was built deliberately insecure, then fixed.** The tag `before` carries exactly one seeded flaw for each of the audit's checks a to f, each marked in the code with a `FLAW (check x)` comment. The fix pull request repairs a to e with new migrations and code changes. The flaw comments in the migrations that were already applied stay, because an applied migration is never edited; each new migration names the flaw it fixes. Flaw f stays too: the migration that dropped `customers.notes` cannot be undone, so the fix adds a CI step that stops the next one. Check g's flaw, the checkout that trusts the booking page's price, check h's, the AI summary anyone can call, check i's, the staff password reset whose email goes through Supabase's test-only email service, and check k's, the customer photos in a public bucket whose read policy only looks private, landed on `main` with their checks, and the launch fixes pull request repairs them; check k's flaw comment stays in its migration, which was already applied. Run the app only against the local stack. Never deploy it.

| Check | The flaw | Where | Fixed by |
|---|---|---|---|
| a | `staff_notes` has row level security off | `supabase/migrations/20260915110000_staff_notes.sql` | `supabase/migrations/20261002090000_staff_notes_rls.sql`: RLS on, staff-only policies |
| b | The booking form's anon INSERT policy on `appointments` is `with check (true)` | `supabase/migrations/20260901090000_init.sql` | `supabase/migrations/20261002090100_booking_insert_policy.sql`: visitors may add only a future booking with status `booked` |
| c | `appointments_for_phone` is SECURITY DEFINER, anon can execute it, and it has no `search_path` | `supabase/migrations/20260908100000_find_my_booking.sql` | `supabase/migrations/20261002090200_remove_find_my_booking.sql` drops it; the booking page shows a booking reference instead |
| d | The local stack's service-role key in a `supabaseAdmin` client the Customers page uses | `src/integrations/supabase/admin.ts` | The file is deleted and Customers uses the anon-key client; the key stays in the git history, so it must be rotated |
| e | `enable_confirmations = false` under `[auth.email]`, and the Reports route has no auth check | `supabase/config.toml`, `src/App.tsx` | Confirmations on; `/reports` moved inside `ProtectedRoute` |
| f | A migration drops `customers.notes` | `supabase/migrations/20260915110000_staff_notes.sql` | Not undoable; `.github/workflows/migrations-check.yml` fails a pull request that adds such a migration |
| g | The checkout trusts the price the booking page sends | `supabase/functions/create-checkout/index.ts` | The launch fixes pull request: the booking page sends only the appointment id, and the function reads the appointment's service with the service role and charges the price in `supabase/functions/create-checkout/prices.ts` |
| h | The Reports page's AI summary function can be called by anyone and bills the salon's OpenAI account | `supabase/functions/summarise-weeks/index.ts`, `supabase/config.toml` | The launch fixes pull request: the function reads the user with `supabase.auth.getUser()` and answers 401 without one, before calling OpenAI; `verify_jwt = false` is gone from `config.toml` |
| i | Staff password reset emails go through Supabase's built-in email service, which is for testing only, because `config.toml` sets up no SMTP server | `src/pages/Login.tsx`, `supabase/config.toml` | The launch fixes pull request: `[auth.email.smtp]` in `config.toml` sends auth emails through Resend, with the key from `RESEND_API_KEY` |
| k | Staff add customer photos to the bucket `customer-photos`, which is public, so anyone with a photo's URL can download it, though the read policy lets staff read only the photos they added | `supabase/migrations/20261008090000_customer_photos.sql`, `src/pages/CustomerDetail.tsx` | The launch fixes pull request: `supabase/migrations/20261009090000_customer_photos_private.sql` makes the bucket private, and the customer's page shows photos through `createSignedUrl` |

Pages: a public "Book an appointment" form that gives a booking reference (`/`), staff sign in (`/login`), the staff password reset (`/reset-password`, from "Forgot your password?" on the sign-in page), Appointments (with each booking's reference), Customers, a customer's detail with their appointments and photos, staff notes per customer, and Reports (appointments per week).

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

The three edge functions in `supabase/functions/` (`create-checkout`, `stripe-webhook` and `summarise-weeks`) need `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `OPENAI_API_KEY` only to run them for real, which the audit and the tests never do: the audit only reads them, and `test/demo-functions.test.ts` runs `create-checkout` and `summarise-weeks` in Node with Stripe, Supabase and OpenAI faked.

Sign in as staff with `mia@example.com` or `sam@example.com`, password `salon-demo-password` (seeded by `supabase/seed.sql`). Every name, phone number and email address in the seed data is made up.

The local stack sends auth emails, such as a password reset, through the SMTP server in `[auth.email.smtp]`, Resend, as the live project does, and not to its mail viewer at http://127.0.0.1:56324: the Supabase CLI uses that table locally whenever it is set. With `RESEND_API_KEY` unset, as in CI, the password it gives Resend is the literal text `env(RESEND_API_KEY)`, so no reset email arrives. Never put a real key in this repo.
