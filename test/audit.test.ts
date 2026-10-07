import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { mask } from '../src/checks/secrets.ts';
import { main } from '../src/main.ts';
import { FAKE, commitAll, gitRepo, stripeKey, tempDir, writeFiles } from './repo.ts';

it('runs checks d, e and f, and a without --db, and no report output contains a secret in full', async () => {
  const root = await gitRepo();
  const deleted = stripeKey('Hst1');
  await writeFiles(root, { 'app/scripts/old.ts': `"${deleted}"\n` });
  commitAll(root, 'a key');
  await rm(path.join(root, 'app/scripts/old.ts'));
  await writeFiles(root, {
    'app/src/keys.ts': Object.values(FAKE).map((value) => `"${value}"`).join('\n'),
    'app/.env': `VITE_SUPABASE_URL=${FAKE.dbUrl}\n`,
    'app/supabase/config.toml': '[auth.email]\nenable_confirmations = false\n',
    'app/supabase/migrations/20260101000000_drop.sql': 'alter table public.a drop column b;\n',
  });
  commitAll(root, 'keys');

  const out = await tempDir();
  const code = await main(['audit', path.join(root, 'app'), '--out', out], { stderr: () => {} });
  expect(code).toBe(1);

  const markdown = await readFile(path.join(out, 'report.md'), 'utf8');
  const json = await readFile(path.join(out, 'report.json'), 'utf8');
  expect(markdown).toContain('**Summary:** 9 critical, 0 high, 1 medium, 1 low; 0 to review, 9 manual actions.');
  const checks = JSON.parse(json).findings.map((f: { check: string }) => f.check);
  expect([...new Set(checks)].sort()).toEqual(['a', 'd', 'e', 'f', 'i']);

  for (const secret of [...Object.values(FAKE), deleted]) {
    expect(markdown).not.toContain(secret);
    expect(json).not.toContain(secret);
  }
  expect(markdown).toContain(mask(FAKE.serviceRoleJwt));
  expect(markdown).toContain(mask(deleted));
});
