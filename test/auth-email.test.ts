import { describe, expect, it } from 'vitest';
import { AUTH_EMAIL_MANUAL_CHECKS, authEmailCalls, authEmailCheck } from '../src/checks/auth-email.ts';
import type { Finding } from '../src/findings.ts';
import { commitAll, git, gitRepo, tempDir, writeFiles } from './repo.ts';

const run = async (repoPath: string) => authEmailCheck.run({ repoPath, exposedSchemas: ['public'] });
const where = (f: Finding) => ('file' in f.location ? `${f.location.file}:${f.location.line}` : f.location.object);
const summary = (findings: Finding[]) => findings.map((f) => `${f.severity ?? f.kind} ${where(f)}`).sort();
const raised = (findings: Finding[]) => findings.filter((f) => f.severity !== undefined);

describe('authEmailCalls', () => {
  it.each([
    { line: 'const { error } = await supabase.auth.signUp({ email, password });', email: 'sign-up confirmation' },
    { line: 'const { error } = await supabase.auth.resetPasswordForEmail(email, {', email: 'password reset' },
    { line: 'await supabase.auth.signInWithOtp({ email });', email: 'sign-in link' },
    { line: 'await supabase.auth.resend({ type: "signup", email });', email: 'sign-up confirmation' },
    { line: 'await supabaseAdmin.auth.admin.inviteUserByEmail(email);', email: 'invitation' },
    { line: 'onClick={() => supabase.auth.resetPasswordForEmail(email)}', email: 'password reset' },
  ])('finds $line', ({ line, email }) => {
    expect(authEmailCalls(`const a = 1;\n${line}\n`)).toEqual([{ line: 2, email }]);
  });

  it.each([
    'await supabase.auth.signInWithPassword({ email, password });',
    'await supabase.auth.updateUser({ password });',
    'await supabase.auth.signInWithOAuth({ provider: "google" });',
    'await supabaseAdmin.auth.admin.generateLink({ type: "invite", email });',
    'await resend.emails.send({ from, to, subject, html });',
    'const signUp = async () => {',
    'await supabase.auth.admin.signUp(x);',
    '// await supabase.auth.resetPasswordForEmail(email);',
    '/*\n * await supabase.auth.resetPasswordForEmail(email);\n */',
  ])('does not find %j', (src) => {
    expect(authEmailCalls(`${src}\n`)).toEqual([]);
  });

  it('gives both lines of a text with two calls, in order', () => {
    const src = ['await supabase.auth.signUp({ email, password });', 'const x = 1;', 'await supabase.auth.resetPasswordForEmail(email);'].join('\n');
    expect(authEmailCalls(src)).toEqual([
      { line: 1, email: 'sign-up confirmation' },
      { line: 3, email: 'password reset' },
    ]);
  });

  it('gives nothing for a commented-out reset, with // and inside a block comment', () => {
    expect(authEmailCalls('// supabase.auth.resetPasswordForEmail(email)')).toEqual([]);
    expect(authEmailCalls('/*\n * supabase.auth.resetPasswordForEmail(email)\n */')).toEqual([]);
  });

  it.each(['', '\0\0', '}{)(', 'const { = ', 'stripe.prices.create({ amount: [', 'const x = req.body\n'.repeat(3), 'import x from "'])(
    'does not throw on %j',
    (text) => {
      expect(() => authEmailCalls(text)).not.toThrow();
    },
  );
});

// The demo's sign-in page, as it is on main: the reset email is sent for the address typed in.
const RESET_LINE = '    const { error } = await supabase.auth.resetPasswordForEmail(email, {';
const FLAWED_LOGIN = [
  'export default function Login() {',
  '  const forgotPassword = async () => {',
  '    if (!email) return;',
  RESET_LINE,
  '      redirectTo: `${window.location.origin}/reset-password`,',
  '    });',
  '    if (error) setError(error.message);',
  '  };',
  '  return <Button type="button" variant="link" onClick={forgotPassword}>Forgot your password?</Button>;',
  '}',
].join('\n');

const lineOf = (src: string, text: string) => src.split('\n').findIndex((l) => l.includes(text)) + 1;
const FLAWED_LINE = lineOf(FLAWED_LOGIN, 'resetPasswordForEmail(');
const CONFIRMATIONS_ONLY = '[auth.email]\nenable_confirmations = true\n';
const FIX_SNIPPET = '[auth.email.smtp]\nenabled = true\nhost = "smtp.resend.com"\nport = 465\n';

async function fixture(config: string | undefined, files: Record<string, string> = { 'src/pages/Login.tsx': FLAWED_LOGIN }) {
  const root = await tempDir();
  await writeFiles(root, { ...(config === undefined ? {} : { 'supabase/config.toml': config }), ...files });
  return root;
}

const MANUAL_ONLY = AUTH_EMAIL_MANUAL_CHECKS.map((f) => `manual ${where(f)}`).sort();

describe('authEmailCheck', () => {
  it("has the id 'i'", () => {
    expect(authEmailCheck.id).toBe('i');
  });

  it('triggers: the sign-in page with a password reset and no custom SMTP is one high at the reset line', async () => {
    const findings = await run(await fixture(CONFIRMATIONS_ONLY));
    expect(summary(raised(findings))).toEqual([`high src/pages/Login.tsx:${FLAWED_LINE}`]);
    const [first] = raised(findings);
    expect(first).toMatchObject({
      check: 'i',
      title: "Auth emails go through Supabase's built-in email service, which is for testing only",
    });
    expect(first!.why).toContain("the app's password reset emails");
    expect(first!.fix?.snippet?.code).toContain('[auth.email.smtp]');
    expect(first!.checkBefore).not.toBe('');
    expect(findings.slice(1)).toEqual(AUTH_EMAIL_MANUAL_CHECKS);
  });

  it.each([
    { name: 'only [local_smtp], as in the demo', config: '[local_smtp]\nenabled = true\nport = 56324\n' },
    { name: 'an [auth.email.smtp] with enabled = false and a host', config: '[auth.email.smtp]\nenabled = false\nhost = "smtp.resend.com"\n' },
    { name: 'an [auth.email.smtp] with enabled = true and an empty host', config: '[auth.email.smtp]\nenabled = true\nhost = ""\n' },
  ])('triggers on a config with $name', async ({ config }) => {
    const findings = await run(await fixture(config));
    expect(summary(raised(findings))).toEqual([`high src/pages/Login.tsx:${FLAWED_LINE}`]);
    expect(summary(findings)).toHaveLength(3);
  });

  it('names every kind in one finding, at the first call', async () => {
    const root = await fixture(CONFIRMATIONS_ONLY, {
      'src/pages/SignUp.tsx': 'const a = 1;\nawait supabase.auth.signUp({ email, password });\n',
      'supabase/functions/invite-staff/index.ts': 'await supabaseAdmin.auth.admin.inviteUserByEmail(email);\n',
    });
    const high = raised(await run(root));
    expect(summary(high)).toEqual(['high src/pages/SignUp.tsx:2']);
    expect(high[0]!.why).toContain('sign-up confirmation and invitation');
  });

  it('lists three kinds with commas and "and"', async () => {
    const root = await fixture(CONFIRMATIONS_ONLY, {
      'src/a.ts': 'await supabase.auth.signUp({ email, password });\n',
      'src/b.ts': 'await supabase.auth.resetPasswordForEmail(email);\n',
      'src/c.ts': 'await supabase.auth.signInWithOtp({ email });\n',
    });
    expect(raised(await run(root))[0]!.why).toContain('sign-up confirmation, password reset and sign-in link emails');
  });

  it("does not trigger on the demo's password reset with custom SMTP set up (the fixed state)", async () => {
    const findings = await run(await fixture(`${CONFIRMATIONS_ONLY}\n${FIX_SNIPPET}`));
    expect(raised(findings)).toEqual([]);
    expect(findings).toEqual(AUTH_EMAIL_MANUAL_CHECKS);
  });

  it('does not trigger on an [auth.email.smtp] with a host and no enabled key', async () => {
    const findings = await run(await fixture('[auth.email.smtp]\nhost = "env(SMTP_HOST)"\n'));
    expect(raised(findings)).toEqual([]);
  });

  it('does not trigger without a supabase/config.toml', async () => {
    const findings = await run(await fixture(undefined));
    expect(raised(findings)).toEqual([]);
    expect(findings).toEqual(AUTH_EMAIL_MANUAL_CHECKS);
  });

  it('does not trigger with a config but no auth email call', async () => {
    const root = await fixture(CONFIRMATIONS_ONLY, {
      'src/pages/Login.tsx': 'await supabase.auth.signInWithPassword({ email, password });\n',
    });
    const findings = await run(root);
    expect(raised(findings)).toEqual([]);
    expect(findings).toEqual(AUTH_EMAIL_MANUAL_CHECKS);
  });

  it('in a git repo reads only tracked files: an untracked reset gives nothing, the committed one a high', async () => {
    const root = await gitRepo();
    await writeFiles(root, {
      'README.md': 'x',
      'supabase/config.toml': CONFIRMATIONS_ONLY,
      'src/pages/Login.tsx': FLAWED_LOGIN,
    });
    git(root, 'add', 'README.md', 'supabase/config.toml');
    git(root, 'commit', '-q', '-m', 'config only');
    expect(raised(await run(root))).toEqual([]);
    commitAll(root, 'track login');
    expect(summary(raised(await run(root)))).toEqual([`high src/pages/Login.tsx:${FLAWED_LINE}`]);
  });
});

describe('the manual entries', () => {
  it('are the only findings on an empty directory', async () => {
    expect(await run(await tempDir())).toEqual(AUTH_EMAIL_MANUAL_CHECKS);
  });

  it('are the two checks, in order', () => {
    expect(AUTH_EMAIL_MANUAL_CHECKS.map((f) => [f.kind, f.title, 'object' in f.location ? f.location.object : ''])).toEqual([
      ['manual', 'Auth emails go through your own SMTP server', 'Supabase dashboard: Authentication > Emails > SMTP Settings'],
      ['manual', 'The sending domain has SPF, DKIM and DMARC records', "The sending domain's DNS records"],
    ]);
    expect(AUTH_EMAIL_MANUAL_CHECKS.every((f) => f.check === 'i' && f.fix?.snippet === undefined)).toBe(true);
  });

  it('are listed with every fixture, flawed or fixed', async () => {
    for (const config of [CONFIRMATIONS_ONLY, FIX_SNIPPET, undefined]) {
      const findings = await run(await fixture(config));
      expect(summary(findings.filter((f) => f.kind === 'manual'))).toEqual(MANUAL_ONLY);
    }
  });
});
