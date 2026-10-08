# Is your Lovable app showing your customers' data to strangers?

Lovable, Bolt and Cursor build an app that works. Whether a stranger can read its database is a different question, and the app working tells you nothing about it.

In 2025 a security researcher reported Lovable-built apps whose databases anyone on the internet could read and change ([CVE-2025-48757](https://www.cve.org/CVERecord?id=CVE-2025-48757)). Lovable disputed the report: in its view, protecting each app's data is the app owner's responsibility. So it is yours. Built-in security scans help, but Lovable's own [security documentation](https://docs.lovable.dev/features/security) says they cannot guarantee an app is secure.

I check apps like these and fix what I find. Here is a sample.

## The sample: a hair salon's booking app

Juniper & Ash Hair Studio is a fictional salon with the kind of app Lovable builds: a public "Book an appointment" form, a staff sign-in, a customer list, staff notes per customer and a reports page. I built it with the problems apps like this typically have, then checked it and fixed it.

## What a stranger could do

| Anyone on the internet could… | How serious | What I changed |
|---|---|---|
| Read, change or delete every staff note, including customers' allergies and payment notes. | Critical | Only signed-in staff can see or change notes. |
| Fill the calendar with fake bookings: in the past, or already marked "confirmed" or "completed". | Critical | The form still takes bookings from anyone, but only for a future time, and only as a new booking. |
| Type in any phone number and see that person's appointments. | Critical | "Find my booking" is gone. Customers get a booking reference that staff can look up. |
| Copy the database's master key out of the website's code, and with it read, change or delete everything. | Critical | The key is out of the website. The Customers page now uses the staff member's own sign-in. |
| Sign up with someone else's email address. | Medium | Email confirmation is on in the app's settings file. The same switch in the Supabase dashboard is on the to-do list below. |
| Open the Reports page without signing in. | Needed a decision: the page might have been meant to be public | Reports are behind the staff sign-in. |
| Pay £1 for a £120 balayage: the checkout charged whatever price the booking page sent, and anyone can change that. | Critical | Checkout looks up the service's price itself. The booking page only says which booking is being paid for. |
| Run up the salon's OpenAI bill by calling the Reports page's AI summary over and over, without signing in. | High | Before it calls OpenAI, the AI summary refuses anyone who is not signed in ([the launch fixes](https://github.com/LucaFastDev/supabase-rescue/pull/46)), and anyone signed in who is not on the salon's staff ([the staff-only fix](https://github.com/LucaFastDev/supabase-rescue/pull/59)). |
| Open a customer's photo with its link. The photos looked private, since staff saw only their own, but they were in a public folder. | High | The photo folder is private. Staff see the photos through links that stop working after an hour. |
| (Not a stranger, but it would have broken the app at launch.) Staff password-reset emails went through Supabase's email service for testing, which sends about two an hour and only to the project's own team, so they would stop arriving once the salon used the app. | High | Sign-in emails go through the salon's own email provider, set in the app's settings file. The same setting in the Supabase dashboard is on the to-do list below. |
| (Not a stranger, but the same kind of mistake.) An earlier update removed a column the app still read. The notes in it were moved first, but every browser tab already open on the app broke the moment it ran. | Low | An update that has run cannot be undone. A new check stops the next one like it before it ships. |

## Why "just ask Lovable to fix it" is risky

Each of these has an obvious fix, and the obvious fix often breaks the app.

- **Locking a table locks out your own app too.** Turn on protection for the staff notes and the notes page goes blank until the right rules exist. Getting the rules right means knowing who should see what, page by page.
- **The standard fix for the booking form kills the booking form.** The usual advice is "only signed-in users can add bookings". That closes the hole, and no customer can book any more. My fix keeps the form open to everyone and refuses only bookings that make no sense.
- **Deleting the master key from the code does not get rid of it.** It stays in the project's history, where anyone with a copy of the code can find it. The key has to be replaced in Supabase, and everything that uses it given the new one first.
- **Some features cannot be made safe as they are.** "Find my booking" by phone number could not be locked down without breaking it, so it was redesigned around a booking reference.

The fixes came as three tested changes to the app, the way you would receive them: [the database fixes](https://github.com/LucaFastDev/supabase-rescue/pull/10), [the launch fixes](https://github.com/LucaFastDev/supabase-rescue/pull/46) and [the staff-only fix to the AI summary](https://github.com/LucaFastDev/supabase-rescue/pull/59).

## After the fix

The same check found nothing critical, serious or medium. Five kinds of thing are left, and none can be done from the code:

- **Replace the master key in the Supabase dashboard.** Turning off the old keys is not enough: the leaked key keeps working until the secret that signed it is revoked or replaced. Do it once every place that uses the key has been found; the report says where and in what order.
- **Five settings in the Supabase dashboard**, such as refusing passwords known from data breaches. The check cannot see them from outside, so the report lists exactly where to click.
- **Two checks on sign-in emails.** The salon's email provider has to be turned on in the Supabase dashboard too, and the salon's domain needs the records (SPF, DKIM and DMARC) that keep those emails out of spam. The check cannot see either, so the report says how to set both up.
- **A paid Supabase plan, with daily backups.** The free plan keeps no backups and pauses an app after a quiet week. The check cannot see which plan the project is on.
- **The earlier update that broke open tabs stays applied.** It cannot be undone, so it is reported to make sure the next one like it is caught.

## What you get

A report like the [before report](before/report.md): every problem, how serious it is, why it matters, the fix, and what to check before applying it. The [after report](after/report.md) is the same check run again once the fixes are in.

## How we work together

One package: **analyse and fix.** I check your app and send you the report, so you see every problem and its fix before anything changes. Then I make the fixes myself, as one change to your app, tested against it, like the sample's.

**What I need from you.** Access to your project's GitHub repository, with permission to change it, or I send the changes for you to accept (if your project is not on GitHub yet, Lovable's GitHub integration puts it there). A way to apply the database changes: your own setup, or an invitation to your Supabase organization that you remove afterwards. Optionally, for the check, **a separate login** to your database with limited access: I send you a short script that creates it, you run it and choose its password, it has no direct access to the rows in your tables, it can see which of your file storage folders (buckets) are public but not the files in them, and you delete it when I am done.

<!-- TODO operator: replace UPWORK_PROFILE_URL with the Upwork profile link before this page is shown to anyone. -->
**[Hire me to check yours](UPWORK_PROFILE_URL)**
