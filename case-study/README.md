# Is your Lovable app showing your customers' data to strangers?

Lovable, Bolt and Cursor build an app that works. Whether a stranger can read its database is a different question, and the app working tells you nothing about it.

In 2025 a security researcher reported Lovable-built apps whose databases anyone on the internet could read and change ([CVE-2025-48757](https://nvd.nist.gov/vuln/detail/CVE-2025-48757)). Lovable disputed the report: in its view, protecting each app's data is the app owner's responsibility. So it is yours. Built-in security scans help, but Lovable's own [security documentation](https://docs.lovable.dev/features/security) says they cannot guarantee an app is secure.

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
| Sign up with someone else's email address. | Medium | New accounts must confirm their email. |
| Open the Reports page without signing in. | Needed a decision: the page might have been meant to be public | Reports are behind the staff sign-in. |
| (Not a stranger, but the same kind of mistake.) An earlier update deleted the customers' notes column: the notes are gone, and browser tabs already open on the app broke. | Low | Deleted data cannot come back. A new check stops the next update like it before it ships. |

## Why "just ask Lovable to fix it" is risky

Each of these has an obvious fix, and the obvious fix often breaks the app.

- **Locking a table locks out your own app too.** Turn on protection for the staff notes and the notes page goes blank until the right rules exist. Getting the rules right means knowing who should see what, page by page.
- **The standard fix for the booking form kills the booking form.** The usual advice is "only signed-in users can add bookings". That closes the hole, and no customer can book any more. My fix keeps the form open to everyone and refuses only bookings that make no sense.
- **Deleting the master key from the code does not get rid of it.** It stays in the project's history, where anyone with a copy of the code can find it. The key has to be replaced in Supabase, and everything that uses it given the new one first.
- **Some features cannot be made safe as they are.** "Find my booking" by phone number could not be locked down without breaking it, so it was redesigned around a booking reference.

Every fix was made as one tested change to the app ([the fix](https://github.com/LucaFastDev/supabase-rescue/pull/10)), the way you would receive it.

## After the fix

The same check found nothing critical, serious or medium. Three kinds of thing are left, and none can be done from the code:

- **Replace the master key in the Supabase dashboard.** A few minutes; the report says where and in what order.
- **Five settings in the Supabase dashboard**, such as refusing passwords known from data breaches. The check cannot see them from outside, so the report lists exactly where to click.
- **The deleted notes stay deleted.** That one is reported so the next update like it is caught.

## What you get

A report like the [before report](before/report.md): every problem, how serious it is, why it matters, the fix, and what to check before applying it. The [after report](after/report.md) is the same check run again once the fixes are in.

## How we work together

One package: **analyse and fix.** I check your app and send you the report, so you see every problem and its fix before anything changes. Then I make the fixes myself, as one change to your app, tested against it, like the sample's.

**What I need from you.** Access to your project's GitHub repository, with permission to change it, or I send the changes for you to accept (if your project is not on GitHub yet, Lovable's GitHub integration puts it there). A way to apply the database changes: your own setup, or an invitation to your Supabase organization that you remove afterwards. Optionally, for the check, a read-only login to your database: I send you the one command that creates it, it cannot read your customers' data directly, and you delete it when I am done.

<!-- TODO operator: replace UPWORK_PROFILE_URL with the Upwork profile link before this page is shown to anyone. -->
**[Hire me to check yours](UPWORK_PROFILE_URL)**
