// Check i: auth email deliverability. Reads only the repo, never the database, and reports one
// thing: the app's code asks Supabase to send an auth email (signUp, resetPasswordForEmail,
// signInWithOtp, resend or inviteUserByEmail) while supabase/config.toml sets up no custom SMTP
// server: high. Every report also lists two manual checks, custom SMTP in the dashboard and the
// sending domain's SPF, DKIM and DMARC records, because neither can be read from the repo.
//
// Like checks d to h this is a line scanner over source text, not a parser, so a call split across
// lines is missed. A case it misses is acceptable; a crash on odd source text is not.

import path from 'node:path';
import { readConfig } from '../config.ts';
import { walkFiles } from '../files.ts';
import type { Finding } from '../findings.ts';
import { NOT_READABLE } from './auth.ts';
import type { Check } from './index.ts';
import { withoutComments } from './payments.ts';
import { git, inGitRepo, readScannable } from './secrets.ts';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const AUTH_EMAIL_CALL =
  /\bauth\s*\.\s*(?:(signUp|resetPasswordForEmail|signInWithOtp|resend)|admin\s*\.\s*(inviteUserByEmail))\s*\(/;

const EMAIL_KINDS: Record<string, string> = {
  signUp: 'sign-up confirmation',
  resend: 'sign-up confirmation',
  resetPasswordForEmail: 'password reset',
  signInWithOtp: 'sign-in link',
  inviteUserByEmail: 'invitation',
};

/** Every 1-based line that asks Supabase to send an auth email, with the kind of the first call on it. */
export function authEmailCalls(src: string): { line: number; email: string }[] {
  const calls: { line: number; email: string }[] = [];
  withoutComments(src).forEach((text, i) => {
    const match = AUTH_EMAIL_CALL.exec(text);
    if (match) calls.push({ line: i + 1, email: EMAIL_KINDS[(match[1] ?? match[2])!]! });
  });
  return calls;
}

const SNIPPET = `[auth.email.smtp]
enabled = true
host = "smtp.resend.com"
port = 465
user = "resend"
pass = "env(RESEND_API_KEY)"
admin_email = "no-reply@yourdomain.com"
sender_name = "Your app"
`;

function joinList(items: string[]): string {
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
}

function finding(file: string, line: number, emails: string): Finding {
  return {
    check: 'i',
    severity: 'high',
    title: "Auth emails go through Supabase's built-in email service, which is for testing only",
    location: { file, line },
    why: `This line asks Supabase to send an auth email, and supabase/config.toml sets up no SMTP server of your own, so the app's ${emails} emails go through Supabase's built-in email service. That service is for testing only: it sends about 2 emails an hour, and only to the addresses of your Supabase project's team members. Once real users arrive, these emails do not reach them, so anything that waits on one, such as confirming an account or resetting a password, stops working.`,
    fix: {
      text: "Send auth emails through an email provider's SMTP server. With Resend, for example: add your domain in Resend and add the DNS records it lists until it shows as verified, create an API key, then in the Supabase dashboard (Authentication, Emails, SMTP Settings) turn on custom SMTP with host smtp.resend.com, port 465, user resend, the API key as the password, and a sender address on your verified domain. Any SMTP provider works the same way. Set the same in supabase/config.toml, as below, so the file matches the live project.",
      snippet: { language: 'toml', code: SNIPPET },
    },
    checkBefore:
      'Whether the live project already sends through custom SMTP set in the Supabase dashboard, which the tool cannot read: if it does, this finding does not apply, though supabase/config.toml should say so too. A signInWithOtp or resend call that sends a text message rather than an email is matched as well, and needs no SMTP. Before switching, verify the sending domain with the provider (see the manual check on SPF, DKIM and DMARC), or the emails will be refused or land in spam.',
  };
}

export const AUTH_EMAIL_MANUAL_CHECKS: Finding[] = [
  {
    check: 'i',
    kind: 'manual',
    title: 'Auth emails go through your own SMTP server',
    location: { object: 'Supabase dashboard: Authentication > Emails > SMTP Settings' },
    why: `Supabase's built-in email service is for testing only: it sends about 2 emails an hour, and only to your project's team members, so real users get no sign-up, password reset or sign-in emails. ${NOT_READABLE}`,
    fix: {
      text: "In the Supabase dashboard, Authentication, Emails, SMTP Settings: turn on custom SMTP and enter your email provider's details. With Resend, for example: host smtp.resend.com, port 465, user resend, a Resend API key as the password, and a sender address on a domain you have verified in Resend. Any SMTP provider works.",
    },
    checkBefore:
      'That the sender address is on a domain verified with the provider (see the manual check on SPF, DKIM and DMARC), then send yourself a password reset to test it. Supabase starts custom SMTP with a low hourly email limit, which you can raise under Authentication, Rate Limits.',
  },
  {
    check: 'i',
    kind: 'manual',
    title: 'The sending domain has SPF, DKIM and DMARC records',
    location: { object: "The sending domain's DNS records" },
    why: 'Without them, inbox providers such as Gmail and Outlook treat your auth emails as possibly forged and send them to spam or refuse them, so users never see their confirmation or reset link. The tool reads only the repo and the database, and a domain\'s DNS records are in neither.',
    fix: {
      text: "At your domain's DNS host, add the records your email provider lists. With Resend, for example: add the domain under Domains, add the SPF and DKIM records it shows, and wait until it shows as verified. Then add a DMARC record: a TXT record named _dmarc with the value v=DMARC1; p=none; and change p=none to p=quarantine once your emails are arriving.",
    },
    checkBefore:
      'Any SPF record the domain already has, for example for its own mailboxes: a domain may have only one, so add the provider to it rather than adding a second.',
  },
];

export const authEmailCheck: Check = {
  id: 'i',
  async run({ repoPath }) {
    const config = await readConfig(repoPath);
    if (!config || config.smtpHost !== undefined) return [...AUTH_EMAIL_MANUAL_CHECKS];

    // The same files as checks g and h: what git tracks under the path, or every file outside a repo.
    const repo = await inGitRepo(repoPath);
    const files = repo
      ? (await git(repoPath, ['-c', 'core.quotePath=false', 'ls-files', '-z'])).split('\0').filter(Boolean).sort()
      : await walkFiles(repoPath);

    const calls: { file: string; line: number; email: string }[] = [];
    for (const file of files.filter((f) => SOURCE_EXTENSIONS.has(path.posix.extname(f)))) {
      const text = await readScannable(path.join(repoPath, file));
      if (text === undefined) continue;
      for (const call of authEmailCalls(text)) calls.push({ file, ...call });
    }
    if (calls.length === 0) return [...AUTH_EMAIL_MANUAL_CHECKS];

    const emails = joinList([...new Set(calls.map((call) => call.email))]);
    return [finding(calls[0]!.file, calls[0]!.line, emails), ...AUTH_EMAIL_MANUAL_CHECKS];
  },
};
