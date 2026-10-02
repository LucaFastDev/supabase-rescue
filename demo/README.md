# Juniper & Ash Hair Studio: the flawed sample app

A small booking app for a fictional hair salon, written the way a fresh Lovable project is: React, Vite, TypeScript, Tailwind with shadcn/ui, supabase-js and React Router. The audit in the root of this repo is proven against it.

**It is deliberately insecure.** It carries exactly one seeded flaw for each of the audit's checks a to f, each marked in the code with a `FLAW (check x)` comment. Run it only against the local stack. Never deploy it.

| Check | The flaw | Where |
|---|---|---|
| a | `staff_notes` has row level security off | `supabase/migrations/20260915110000_staff_notes.sql` |
| b | The booking form's anon INSERT policy on `appointments` is `with check (true)` | `supabase/migrations/20260901090000_init.sql` |
| c | `appointments_for_phone` is SECURITY DEFINER, anon can execute it, and it has no `search_path` | `supabase/migrations/20260908100000_find_my_booking.sql` |
| d | The local stack's service-role key in a `supabaseAdmin` client the Customers page uses | `src/integrations/supabase/admin.ts` |
| e | `enable_confirmations = false` under `[auth.email]`, and the Reports route has no auth check | `supabase/config.toml`, `src/App.tsx` |
| f | A migration drops `customers.notes` | `supabase/migrations/20260915110000_staff_notes.sql` |

Pages: a public "Book an appointment" form with "Find my booking" (`/`), staff sign in (`/login`), Appointments, Customers, a customer's detail with their appointments, staff notes per customer, and Reports (appointments per week).

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

Sign in as staff with `mia@example.com` or `sam@example.com`, password `salon-demo-password` (seeded by `supabase/seed.sql`). Every name, phone number and email address in the seed data is made up.
