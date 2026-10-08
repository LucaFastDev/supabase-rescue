# Audit report

**Not ready to launch yet:** these problems could expose your customers' data or cost you money.

- Anyone on the internet can read or change data in your database.
- Anyone on the internet can read or change records they should not reach.
- Anyone on the internet can run a database function with full rights.

1 thing needs a person to look at, listed under Review.

8 things this tool can't see need checking by hand, listed under Manual actions.

**Summary:** 5 critical, 3 high, 1 medium, 1 low; 1 to review, 8 manual actions.

Target: `demo`. Tool: supabase-rescue 0.1.0.

## Critical

### Table public.staff_notes has row level security off

- **Check:** a
- **Where:** `public.staff_notes`
- **Why:** The public schema is exposed through the Data API, and this table has row level security off, so no per-row rule protects it. With Supabase's default grants, anyone who has your anon key, which ships inside your app to every visitor, can read, change and delete every row of it.
- **Fix:** Turn row level security on, together with the policies that allow exactly the access the app needs. To write them, answer one question for each kind of access (read, add, change, delete): who should be allowed, anyone, any signed-in user, or only the user a row belongs to?

```sql
alter table public.staff_notes enable row level security;

-- Then one policy per kind of access. For example, signed-in users reading only their own
-- rows (replace user_id with the column that holds the owner):
-- create policy "Users read their own rows" on public.staff_notes
--   for select to authenticated using ((select auth.uid()) = user_id);
```

- **Check before applying:** Enabling row level security with no policy blocks every read and write by anyone but the table's owner, so the parts of the app that use this table break until its policies exist. Write the policies first and apply them in the same migration as the alter table. Code running on a server with the service-role key is not affected.

### Policy "Anyone can book an appointment" lets anyone add any row in public.appointments

- **Check:** b
- **Where:** `public.appointments policy "Anyone can book an appointment"`
- **Why:** The policy applies to anon for INSERT, and its condition is just `true`, so it allows every row: anyone who has your anon key, which ships inside your app to every visitor, can add any row in this table through the Data API.
- **Fix:** Replace `true` with a condition that says whose rows these are, and limit the policy to the roles that need it. The example limits it to signed-in users and the rows they own; replace user_id with the column that holds a row's owner.

```sql
alter policy "Anyone can book an appointment" on public.appointments
  to authenticated
  with check ((select auth.uid()) = user_id);
```

- **Check before applying:** Which parts of the app use this table, and as whom: after the change, anything that relied on the open policy, such as a sign-up or booking form for visitors, gets an error or no rows. Check the column you compare with auth.uid() exists and is filled on every row.

### Function public.appointments_for_phone(text) runs with its owner's rights and anyone can call it

- **Check:** c
- **Where:** `public.appointments_for_phone(text)`
- **Why:** 1. It is SECURITY DEFINER, so it runs with the rights of its owner, usually postgres, which row level security does not stop, and anyone who has your anon key, which ships inside your app to every visitor, can call it through the Data API. Whatever it reads or changes, any visitor can. 2. It is SECURITY DEFINER and does not set its own search_path, so the names in its body are looked up in the caller's search path. A caller who can create objects in a schema on that path can make it run their own code with the owner's rights.
- **Fix:** It has 2 problems; the SQL fixes each, in the order above.

```sql
revoke execute on function public.appointments_for_phone(text) from anon, public;
grant execute on function public.appointments_for_phone(text) to authenticated; -- only if signed-in users need it

alter function public.appointments_for_phone(text) set search_path = '';
```

- **Check before applying:** Whether the app calls this function before sign-in (supabase.rpc on a page for visitors): after the revoke those calls fail with permission denied. Revoking from public also removes signed-in users' access if it came only through public, so keep the grant to authenticated if they need it. With an empty search_path, every table, type and function the body uses must name its schema, such as public.bookings or auth.uid(). Check the body for unqualified names and run the function once after the change.

### Supabase service-role key eyJhbG…81IU in code that ships to the browser

- **Check:** d
- **Where:** `src/integrations/supabase/admin.ts:7`
- **Why:** src/integrations/supabase/admin.ts is frontend code, which ships to every visitor's browser, so anyone who opens the app can read this key. It bypasses every row level security policy: whoever holds it can read, change and delete every row in the database.
- **Fix:** Rotate the key first. In the Supabase dashboard, Project Settings, API Keys: move everything that uses the legacy anon and service_role keys to the new publishable and secret keys, then disable the legacy keys. Disabling them does not stop this key: it still works when sent as an Authorization: Bearer token. To stop it, in Project Settings, JWT Keys, move to the new JWT signing keys, then revoke the legacy JWT secret. If you keep the legacy keys instead, roll the legacy JWT secret, which replaces the anon key too. Then remove it from src/integrations/supabase/admin.ts and keep it only in server-side secrets (an edge function secret, or your host's environment variables), never in a variable the browser build reads. Deleting the line is not enough: the git history keeps the old key.
- **Check before applying:** Every place that uses this key (servers, edge functions, CI, local env files), so you can give them the new one before the old one stops working.

### Stripe charges an amount the browser sent

- **Check:** g
- **Where:** `supabase/functions/create-checkout/index.ts:28`
- **Why:** The amount on this line comes from the request body, which the visitor's browser sends and anyone can change. A customer can pay 1 EUR for a 100 EUR booking, and Stripe reports the payment as complete.
- **Fix:** Send only what is being bought from the browser, such as the booking or product id, and look the price up on the server, from your database or a price list in the server code. Never take the amount from the request.

```ts
const { bookingId } = await req.json();
const booking = await loadBooking(bookingId); // read on the server
const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  line_items: [{
    quantity: 1,
    price_data: {
      currency: 'eur',
      product_data: { name: booking.service },
      unit_amount: PRICES[booking.service], // the server's price, never the request's
    },
  }],
  client_reference_id: booking.id,
  success_url: `${origin}/paid`,
  cancel_url: `${origin}/`,
});
```

- **Check before applying:** Whether the server already checks this amount against the real price before this line, for example by refusing a request whose amount differs from the price in your database; if it does, this finding does not apply. Also find every page that calls this endpoint: after the fix they send the booking or product id instead of a price.

## High

### Anyone can run up your OpenAI bill through the summarise-weeks edge function

- **Check:** h
- **Where:** `supabase/functions/summarise-weeks/index.ts:15`
- **Why:** supabase/config.toml line 45 sets verify_jwt = false for summarise-weeks, and the function checks no signed-in user, so it runs for any request from anyone. This line calls OpenAI, which bills your account for every call. Anyone who finds the function's address, which the app's own code shows, can call it in a loop and run up the bill, or use up your quota so the feature stops working for your users.
- **Fix:** Make the function refuse anyone who is not signed in: before the paid call, read the user from the request's Authorization header with supabase.auth.getUser() and answer 401 when there is none. Turning verify_jwt back on is not enough by itself, because the public anon key is itself a valid token. If the function must stay public, put a rate limit in front of the paid call instead, and set a monthly spending limit with OpenAI.

```ts
import { createClient } from "npm:@supabase/supabase-js@2";

// Before any paid call: who is asking? The anon key alone is a valid token, so check the user.
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
  global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
});
const { data: { user } } = await supabase.auth.getUser();
if (!user) {
  return new Response("Sign in first", { status: 401 });
}
```

- **Check before applying:** Whether summarise-weeks is meant for visitors who are not signed in, such as a contact form or a public chatbot. If it is, and a rate limit or a spending cap already guards it elsewhere (a limit in front of the function, or a hard monthly limit set with OpenAI), this finding does not apply; if nothing limits it, add a rate limit rather than sign-in. Otherwise, find every page that calls summarise-weeks: after the fix it works only for a signed-in user, which supabase.functions.invoke handles by sending the user's session.

### Auth emails go through Supabase's built-in email service, which is for testing only

- **Check:** i
- **Where:** `src/pages/Login.tsx:25`
- **Why:** This line asks Supabase to send an auth email, and supabase/config.toml sets up no SMTP server of your own, so the app's password reset emails go through Supabase's built-in email service. That service is for testing only: it sends about 2 emails an hour, and only to the addresses of your Supabase project's team members. Once real users arrive, these emails do not reach them, so anything that waits on one, such as confirming an account or resetting a password, stops working.
- **Fix:** Send auth emails through an email provider's SMTP server. With Resend, for example: add your domain in Resend and add the DNS records it lists until it shows as verified, create an API key, then in the Supabase dashboard (Authentication, Emails, SMTP Settings) turn on custom SMTP with host smtp.resend.com, port 465, user resend, the API key as the password, and a sender address on your verified domain. Any SMTP provider works the same way. Set the same in supabase/config.toml, as below, so the file matches the live project.

```toml
[auth.email.smtp]
enabled = true
host = "smtp.resend.com"
port = 465
user = "resend"
pass = "env(RESEND_API_KEY)"
admin_email = "no-reply@yourdomain.com"
sender_name = "Your app"
```

- **Check before applying:** Whether the live project already sends through custom SMTP set in the Supabase dashboard, which the tool cannot read: if it does, this finding does not apply, though supabase/config.toml should say so too. A signInWithOtp or resend call that sends a text message rather than an email is matched as well, and needs no SMTP. Before switching, verify the sending domain with the provider (see the manual check on SPF, DKIM and DMARC), or the emails will be refused or land in spam.

### Public storage bucket with a read policy that does not protect its files

- **Check:** k
- **Where:** `storage.buckets/customer-photos`
- **Why:** The bucket customer-photos is public, and the read policy "Staff read the customer photos they added" on storage.objects limits who may read its files. A public bucket lets anyone who has a file's URL download it, whatever the policies say: storage policies only control what the API lists and returns, not the public URL. So anyone a link reaches, or who guesses one, can open these files, though the policy makes them look private.
- **Fix:** Make the bucket private (in the dashboard under Storage, or with the SQL below), and show its files through signed URLs, which expire, with createSignedUrl instead of getPublicUrl. If the files are meant to be public, the restricting policy can go instead.

```sql
update storage.buckets set public = false where id = 'customer-photos';

-- Then, in the app, a signed URL for each file instead of getPublicUrl, for example for an hour:
-- const { data } = await supabase.storage.from('customer-photos').createSignedUrl(path, 60 * 60);
```

- **Check before applying:** Which pages and emails show these files: once the bucket is private, every public URL stops working, including links already sent or saved, so move the app to signed URLs in the same release. A signed URL works only for the users the bucket's read policies allow, so check those policies let the right people read.

## Medium

### Email confirmation is off in config.toml

- **Check:** e
- **Where:** `supabase/config.toml:34`
- **Why:** enable_confirmations = false lets anyone sign up with an email address they do not own and use the account at once. This file configures the local stack and can be pushed to the live project with supabase config push, so it is often what production runs with too.
- **Fix:** Turn confirmations on, here and in the dashboard (see the manual check "Confirm email is on").

```toml
[auth.email]
enable_confirmations = true
```

- **Check before applying:** That your sign-up flow tells users to check their inbox before signing in. Users who signed up while it was off stay confirmed.

## Low

### Migration drops a column

- **Check:** f
- **Where:** `supabase/migrations/20260915110000_staff_notes.sql:23`
- **Why:** It drops a column. A version of the app that still reads that column, including tabs your users already have open, starts failing the moment it runs, and the data in the column is gone. The safe order is to ship a release that stops using the column, then drop it in a later migration. A migration that has been applied cannot be undone, so this is reported to catch the next one before it ships.
- **Fix:** Add a step to CI that fails a pull request whose new migrations are not backward-compatible. This one checks the migrations a pull request adds for the same patterns this check looks for, and fails too when it cannot check one.

```yaml
# .github/workflows/migration-check.yml
name: migration-check
on:
  pull_request:
    paths: ['supabase/migrations/**']
jobs:
  migrations:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: New migrations are backward-compatible
        shell: bash
        run: |
          list=$(mktemp)
          if ! git diff -z --name-only --diff-filter=A "origin/${{ github.base_ref }}...HEAD" -- 'supabase/migrations/*.sql' > "$list"; then
            echo "::error::Could not list the migrations this pull request adds."
            exit 1
          fi
          status=0
          while IFS= read -r -d '' file; do
            rc=0
            perl -e '
              my $file = shift;
              open(my $fh, "<", $file) or exit 2;
              my $hit = 0;
              while (my $line = <$fh>) {
                chomp $line;
                if ($line =~ /\bdrop\s+(column|table)\b|\brename\s+(column|to)\b|\bset\s+not\s+null\b|\balter\s+column\s+\S+\s+(set\s+data\s+)?type\b|\badd\s+column\b(?![^;,]*\b(default|generated\s+always)\b)[^;,]*\bnot\s+null\b|\btruncate\b/i) { print "$file:$.:$line\n"; $hit = 1; }
              }
              close($fh) or exit 2;
              exit $hit;
            ' -- "$file" || rc=$?
            if [ "$rc" -eq 1 ]; then
              echo "::error file=$file::$file is not backward-compatible: it drops, renames, retypes or truncates, or adds a required column without a default. Split it into backward-compatible steps."
              status=1
            elif [ "$rc" -ne 0 ]; then
              echo "::error file=$file::Could not check $file: perl exited $rc."
              status=1
            fi
          done < "$list"
          exit "$status"
```

- **Check before applying:** Whether this migration has already been applied to production. If it has, confirm the live app no longer depends on what it changed. If it has not, split it into backward-compatible steps before applying it.

## Review

### Route /reports renders data without an auth check

- **Check:** e
- **Where:** `src/App.tsx:29`
- **Why:** The page at /reports (src/pages/Reports.tsx) reads from the database, and neither the route nor the page checks that the visitor is signed in. Whether that data reaches visitors who are not signed in depends on the tables' RLS policies, which a static read cannot see, and the page may be meant to be public.
- **Fix:** If the page is for signed-in users, wrap the route in a component that sends everyone else to the sign-in page, and make sure the RLS policies on the tables it reads allow only the users who should see the rows.

```tsx
function RequireAuth({ children }: { children: JSX.Element }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
  }, []);
  if (session === undefined) return null;
  return session ? children : <Navigate to="/login" replace />;
}

<Route path="/reports" element={<RequireAuth><Page /></RequireAuth>} />
```

- **Check before applying:** Whether this page is meant to be public. A route guard only hides the page: the data itself is protected by the RLS policies on the tables it reads, so check those too.

## Manual actions

### Leaked password protection is on

- **Check:** e
- **Where:** `Supabase dashboard: Authentication > Attack Protection`
- **Why:** It refuses passwords known from public data breaches, which are the first ones attackers try. The tool cannot read the live project's auth settings without the Management API, which it never uses.
- **Fix:** In the Supabase dashboard, Authentication, Attack Protection: turn on leaked password protection.
- **Check before applying:** That your sign-up and password-reset forms show the error the API returns when a password is refused.

### Minimum password length is at least 8

- **Check:** e
- **Where:** `Supabase dashboard: Authentication > Attack Protection`
- **Why:** Short passwords fall to guessing quickly. The tool cannot read the live project's auth settings without the Management API, which it never uses.
- **Fix:** In the Supabase dashboard, Authentication, Attack Protection: set the minimum password length to 8 or more.
- **Check before applying:** That your sign-up form's own validation and message match the new minimum. Existing passwords keep working.

### Confirm email is on

- **Check:** e
- **Where:** `Supabase dashboard: Authentication > Sign In / Providers > Email`
- **Why:** Without email confirmation, anyone can sign up with an address they do not own, and the account works at once. The tool cannot read the live project's auth settings without the Management API, which it never uses.
- **Fix:** In the Supabase dashboard, Authentication, Sign In / Providers, Email: turn on Confirm email.
- **Check before applying:** That your sign-up flow tells users to check their inbox, and that the link in the email goes to an allowed redirect URL.

### Secure email change is on

- **Check:** e
- **Where:** `Supabase dashboard: Authentication > Sign In / Providers > Email`
- **Why:** Without it, a new email address needs confirming only from the new address, so someone with brief access to a signed-in session can move the account to an inbox they control. The tool cannot read the live project's auth settings without the Management API, which it never uses.
- **Fix:** In the Supabase dashboard, Authentication, Sign In / Providers, Email: turn on Secure email change.
- **Check before applying:** How users who can no longer reach their old inbox will change their address: they will need your support.

### Site URL and redirect URLs list only the app's own domains

- **Check:** e
- **Where:** `Supabase dashboard: Authentication > URL Configuration`
- **Why:** Sign-in links, password resets and OAuth sign-ins send users, with their session, to these URLs. A broad wildcard or a domain you do not control lets someone else receive a session. The tool cannot read the live project's auth settings without the Management API, which it never uses.
- **Fix:** In the Supabase dashboard, Authentication, URL Configuration: set Site URL to the app's production address, and list in Redirect URLs only the app's own domains (and localhost while developing), without broad wildcards.
- **Check before applying:** Every redirectTo and emailRedirectTo your app passes, so each one is still on the list.

### Auth emails go through your own SMTP server

- **Check:** i
- **Where:** `Supabase dashboard: Authentication > Emails > SMTP Settings`
- **Why:** Supabase's built-in email service is for testing only: it sends about 2 emails an hour, and only to your project's team members, so real users get no sign-up, password reset or sign-in emails. The tool cannot read the live project's auth settings without the Management API, which it never uses.
- **Fix:** In the Supabase dashboard, Authentication, Emails, SMTP Settings: turn on custom SMTP and enter your email provider's details. With Resend, for example: host smtp.resend.com, port 465, user resend, a Resend API key as the password, and a sender address on a domain you have verified in Resend. Any SMTP provider works.
- **Check before applying:** That the sender address is on a domain verified with the provider (see the manual check on SPF, DKIM and DMARC), then send yourself a password reset to test it. Supabase starts custom SMTP with a low hourly email limit, which you can raise under Authentication, Rate Limits.

### The sending domain has SPF, DKIM and DMARC records

- **Check:** i
- **Where:** `The sending domain's DNS records`
- **Why:** Without them, inbox providers such as Gmail and Outlook treat your auth emails as possibly forged and send them to spam or refuse them, so users never see their confirmation or reset link. The tool reads only the repo and the database, and a domain's DNS records are in neither.
- **Fix:** At your domain's DNS host, add the records your email provider lists. With Resend, for example: add the domain under Domains, add the SPF and DKIM records it shows, and wait until it shows as verified. Then add a DMARC record: a TXT record named _dmarc with the value v=DMARC1; p=none; and change p=none to p=quarantine once your emails are arriving.
- **Check before applying:** Any SPF record the domain already has, for example for its own mailboxes: a domain may have only one, so add the provider to it rather than adding a second.

### The project is on a paid plan, with daily backups

- **Check:** j
- **Where:** `Supabase dashboard: Organization settings > Billing`
- **Why:** The free plan keeps no backups and pauses a project after a week without activity. A paused app is offline until someone restores it, and data lost to a bad change cannot be brought back. The tool cannot see which plan the project is on.
- **Fix:** Move the organization to the Pro plan or above before launch. Paid projects are backed up daily and are not paused for inactivity.
- **Check before applying:** If the project is already on a paid plan, open Database > Backups in the dashboard and check that it lists a backup from the last day.
