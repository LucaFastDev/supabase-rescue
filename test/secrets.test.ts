import { rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSecrets, mask, secretsCheck } from '../src/checks/secrets.ts';
import type { Finding } from '../src/findings.ts';
import { FAKE, HARMLESS, commitAll, git, gitRepo, stripeKey, tempDir, writeFiles } from './repo.ts';

const run = async (repoPath: string) => secretsCheck.run({ repoPath, exposedSchemas: ['public'] });
const where = (f: Finding) => ('file' in f.location ? `${f.location.file}:${f.location.line}` : f.location.object);
const summary = (findings: Finding[]) =>
  findings.map((f) => `${f.severity ?? f.kind} ${where(f)}`).sort();

describe('findSecrets', () => {
  it.each([
    { name: 'a service-role JWT', value: FAKE.serviceRoleJwt, kind: 'service-role-jwt' },
    { name: 'an sb_secret_ key', value: FAKE.sbSecret, kind: 'sb-secret' },
    { name: 'a postgres URL with a password and a remote host', value: FAKE.dbUrl, kind: 'postgres-url' },
    { name: 'a postgres:// URL too', value: FAKE.dbUrl.replace('postgresql', 'postgres'), kind: 'postgres-url' },
    { name: 'a Stripe live key', value: FAKE.stripeLive, kind: 'stripe' },
    { name: 'a Stripe test key', value: FAKE.stripeTest, kind: 'stripe' },
    { name: 'an OpenAI sk- key', value: FAKE.openai, kind: 'openai' },
    { name: 'an OpenAI sk-proj- key', value: FAKE.openaiProject, kind: 'openai' },
    { name: 'an Anthropic sk-ant- key', value: FAKE.anthropic, kind: 'anthropic' },
  ])('finds $name', ({ value, kind }) => {
    expect(findSecrets(`const key = "${value}";`)).toEqual([{ kind, value }]);
  });

  it('takes a postgres URL up to its host as the secret, so its masked form hides the password', () => {
    const [secret] = findSecrets(`DATABASE_URL=${FAKE.dbUrl}:5432/postgres`);
    expect(secret?.value).toBe(FAKE.dbUrl);
    expect(mask(secret!.value)).not.toContain(FAKE.dbPassword.slice(0, 4));
  });

  it.each([
    { name: 'the anon key', line: `const anon = "${HARMLESS.anonJwt}";` },
    { name: 'an sb_publishable_ key', line: `const key = "${HARMLESS.sbPublishable}";` },
    ...HARMLESS.localDbUrls.map((url) => ({ name: `a local database URL (${url.split('@')[1]})`, line: url })),
    ...HARMLESS.placeholderDbUrls.map((url) => ({ name: `a placeholder password (${url.split(':')[2]})`, line: url })),
    { name: 'a postgres URL with an empty password', line: 'postgresql://' + 'postgres:@db.example.com/postgres' },
    { name: 'a JWT-shaped string that does not decode', line: 'eyJ' + 'notjson.eyJ' + 'notjson.sig' },
    { name: 'a kebab-case name starting with sk-', line: 'className="sk-skeleton-loader-wrapper-component-x"' },
  ])('ignores $name', ({ line }) => {
    expect(findSecrets(line)).toEqual([]);
  });

  it('does not take an Anthropic key for an OpenAI one', () => {
    expect(findSecrets(FAKE.anthropic).map((s) => s.kind)).toEqual(['anthropic']);
  });

  it('masks as the first 6 and last 4 characters', () => {
    expect(mask(FAKE.stripeLive)).toBe(`${FAKE.stripeLive.slice(0, 6)}…${FAKE.stripeLive.slice(-4)}`);
    expect(mask('abcdefghijklmnop')).toBe('abcdef…mnop');
  });
});

describe('check d on current files', () => {
  it('finds nothing in a repo without secrets', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      'src/supabase.ts': `export const anon = "${HARMLESS.anonJwt}";\nexport const key = "${HARMLESS.sbPublishable}";\n`,
      '.env': `DATABASE_URL=${HARMLESS.localDbUrls[0]}\n`,
    });
    expect(await run(root)).toEqual([]);
  });

  it('is critical in frontend files and high elsewhere, never frontend under supabase/', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      'src/lib/admin.ts': `\nexport const admin = "${FAKE.serviceRoleJwt}";\n`,
      'public/config.js': `window.KEY = "${FAKE.sbSecret}";\n`,
      'app/page.tsx': `const k = "${FAKE.openai}";\n`,
      'pages/index.tsx': `const k = "${FAKE.openaiProject}";\n`,
      'components/Pay.tsx': `const k = "${FAKE.stripeTest}";\n`,
      'index.html': `<script>const k = "${FAKE.anthropic}"</script>\n`,
      'scripts/seed.ts': `const url = "${FAKE.dbUrl}/postgres";\n`,
      'supabase/functions/pay/index.ts': `const stripe = "${FAKE.stripeLive}";\n`,
      'supabase/src/x.ts': `const k = "${FAKE.sbSecret}";\n`,
      'docs/src/notes.md': `${FAKE.stripeLive}\n`,
    });
    const owners = (await run(root)).map((f) => f.owner);
    expect(new Set(owners)).toEqual(
      new Set(["A secret key ships to every visitor's browser, so anyone can use it.", 'A secret key is saved in your code repository.']),
    );
    expect(summary(await run(root))).toEqual([
      'critical app/page.tsx:1',
      'critical components/Pay.tsx:1',
      'critical index.html:1',
      'critical pages/index.tsx:1',
      'critical public/config.js:1',
      'critical src/lib/admin.ts:2',
      'high docs/src/notes.md:1',
      'high scripts/seed.ts:1',
      'high supabase/functions/pay/index.ts:1',
      'high supabase/src/x.ts:1',
    ]);
  });

  it('is critical for a VITE_, NEXT_PUBLIC_ or EXPO_PUBLIC_ assignment in any .env* file, high for other variables', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      '.env': `VITE_SUPABASE_SERVICE_KEY=${FAKE.serviceRoleJwt}\n`,
      'web/.env.production': `NEXT_PUBLIC_STRIPE=${FAKE.stripeLive}\n`,
      'mobile/.env.local': `export EXPO_PUBLIC_OPENAI=${FAKE.openai}\n`,
      'server/.env': `SUPABASE_SERVICE_ROLE_KEY=${FAKE.serviceRoleJwt}\n`,
      // Not an assignment to a public variable, though one is named: high.
      'tools/.env': `SECRET=${FAKE.sbSecret} # not VITE_SECRET\n`,
      // VITE_ in a file that is not a .env* file: high.
      'config/vars.txt': `VITE_KEY=${FAKE.anthropic}\n`,
    });
    const findings = await run(root);
    expect(summary(findings)).toEqual([
      'critical .env:1',
      'critical mobile/.env.local:1',
      'critical web/.env.production:1',
      'high config/vars.txt:1',
      'high server/.env:1',
      'high tools/.env:1',
    ]);
    const env = findings.find((f) => where(f) === '.env:1')!;
    expect(env.title).toBe(`Supabase service-role key ${mask(FAKE.serviceRoleJwt)} in a browser-exposed env variable`);
    expect(env.why).toContain('VITE_SUPABASE_SERVICE_KEY');
    expect(env.owner).toBe("A secret key ships to every visitor's browser, so anyone can use it.");
    expect(findings.find((f) => where(f) === 'server/.env:1')!.owner).toBe('A secret key is saved in your code repository.');
  });

  it('gives one finding per secret per file, at its first line, critical if any line ships it', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      '.env': `\nSERVICE=${FAKE.stripeLive}\nVITE_STRIPE=${FAKE.stripeLive}\nOTHER=${FAKE.stripeLive}\n`,
      'scripts/a.ts': `// ${FAKE.sbSecret}\n\nconst k = "${FAKE.sbSecret}", j = "${FAKE.sbSecret}";\n`,
      'scripts/b.ts': `const k = "${FAKE.sbSecret}";\n`,
    });
    expect(summary(await run(root))).toEqual(['critical .env:2', 'high scripts/a.ts:1', 'high scripts/b.ts:1']);
  });

  it('skips binary files, files over 1 MB, node_modules/ and .git/ when the path is not a git repo', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      'assets/blob.bin': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(FAKE.stripeLive)]),
      'big.txt': `${FAKE.stripeLive}\n${'x'.repeat(1024 * 1024)}`,
      'node_modules/pkg/index.js': `"${FAKE.stripeLive}"`,
      'src/.git/notes.txt': `"${FAKE.stripeLive}"`,
      'small.txt': `${FAKE.stripeTest}\n`,
    });
    expect(summary(await run(root))).toEqual(['high small.txt:1']);
  });

  it('in a git repo, scans only the files git tracks under the audited path', async () => {
    const root = await gitRepo();
    await writeFiles(root, {
      'app/src/tracked.ts': `"${FAKE.serviceRoleJwt}"\n`,
      'other/tracked.ts': `"${FAKE.sbSecret}"\n`,
    });
    commitAll(root, 'tracked');
    await writeFiles(root, { 'app/src/untracked.ts': `"${FAKE.stripeLive}"\n` });
    expect(summary(await run(path.join(root, 'app')))).toEqual(['critical src/tracked.ts:1']);
  });

  it('names the secret only masked in every field of a finding', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'src/a.ts': Object.values(FAKE).map((v) => `"${v}"`).join('\n') });
    const findings = await run(root);
    // Every fake secret but the bare password, which is a secret only inside its URL.
    expect(findings).toHaveLength(8);
    const text = JSON.stringify(findings);
    for (const value of Object.values(FAKE)) expect(text).not.toContain(value);
  });

  it('finds nothing in a git repo with no commits', async () => {
    const root = await gitRepo();
    await writeFiles(root, { 'a.txt': 'nothing here\n' });
    expect(await run(root)).toEqual([]);
  });
});

describe('check d on the history', () => {
  it('gives one manual entry per secret deleted from the audited path, and nothing for one outside it', async () => {
    const root = await gitRepo();
    const deleted = stripeKey('Del1');
    const outside = stripeKey('Out2');
    const kept = stripeKey('Kpt3');

    await writeFiles(root, { 'README.md': 'repo\n', 'other/leak.ts': `const k = "${outside}";\n` });
    commitAll(root, 'outside the audited path');
    await writeFiles(root, { 'app/src/config.ts': `export const a = 1;\nexport const key = "${deleted}";\n` });
    const added = commitAll(root, 'add a key');
    await writeFiles(root, { 'app/scripts/copy.ts': `"${deleted}"\n`, 'app/scripts/kept.ts': `"${kept}"\n` });
    commitAll(root, 'copy it');
    await rm(path.join(root, 'app/src/config.ts'));
    await rm(path.join(root, 'app/scripts/copy.ts'));
    await rm(path.join(root, 'other/leak.ts'));
    commitAll(root, 'delete the keys');

    const findings = await run(path.join(root, 'app'));
    expect(summary(findings)).toEqual(['high scripts/kept.ts:1', 'manual src/config.ts:2']);
    const manual = findings.find((f) => f.kind === 'manual')!;
    expect(manual.owner).toBeUndefined();
    expect('owner' in manual).toBe(false);
    expect(manual.why).toBe(
      `Rotate this key: it is in the git history at ${added} src/config.ts, and the history keeps it after any fix; the tool cannot see whether you rotated it.`,
    );
    expect(manual.title).toBe(`Rotate the Stripe secret key ${mask(deleted)} found in the git history`);
  });

  it('reads every branch, not only the checked-out one', async () => {
    const root = await gitRepo();
    commitAll(root, 'base');
    // A commit on a branch that is never checked out: main and the working tree never hold the key.
    await writeFiles(root, { 'app/x.ts': `"${stripeKey('Brn4')}"\n` });
    git(root, 'add', 'app/x.ts');
    const commit = git(root, 'commit-tree', git(root, 'write-tree'), '-p', 'HEAD', '-m', 'on a feature branch');
    git(root, 'update-ref', 'refs/heads/feature', commit);
    git(root, 'rm', '-q', '--cached', 'app/x.ts');
    await rm(path.join(root, 'app/x.ts'));
    const sha = git(root, 'rev-parse', '--short', commit);
    expect((await run(path.join(root, 'app'))).map((f) => f.why)).toEqual([
      `Rotate this key: it is in the git history at ${sha} x.ts, and the history keeps it after any fix; the tool cannot see whether you rotated it.`,
    ]);
  });

  it('gives nothing for a history without secrets', async () => {
    const root = await gitRepo();
    await writeFiles(root, { 'app/a.ts': `"${HARMLESS.anonJwt}"\n` });
    commitAll(root, 'anon key');
    await rm(path.join(root, 'app/a.ts'));
    commitAll(root, 'removed');
    expect(await run(path.join(root, 'app'))).toEqual([]);
  });
});
