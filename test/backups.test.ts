import { describe, expect, it } from 'vitest';
import { BACKUPS_MANUAL_CHECKS, backupsCheck } from '../src/checks/backups.ts';
import type { Finding } from '../src/findings.ts';
import { tempDir, writeFiles } from './repo.ts';

const run = async (repoPath: string) => backupsCheck.run({ repoPath, exposedSchemas: ['public'] });

const ENTRY: Finding = {
  check: 'j',
  kind: 'manual',
  title: 'The project is on a paid plan, with daily backups',
  location: { object: 'Supabase dashboard: Organization settings > Billing' },
  why: 'The free plan keeps no backups and pauses a project after a week without activity. A paused app is offline until someone restores it, and data lost to a bad change cannot be brought back. The tool cannot see which plan the project is on.',
  fix: {
    text: 'Move the organization to the Pro plan or above before launch. Paid projects are backed up daily and are not paused for inactivity.',
  },
  checkBefore:
    'If the project is already on a paid plan, open Database > Backups in the dashboard and check that it lists a backup from the last day.',
};

async function appRepo() {
  const root = await tempDir();
  await writeFiles(root, {
    'supabase/config.toml': '[auth.email]\nenable_confirmations = true\n',
    'src/pages/SignUp.tsx': 'await supabase.auth.signUp({ email, password });\n',
  });
  return root;
}

describe('backupsCheck', () => {
  it("has the id 'j'", () => {
    expect(backupsCheck.id).toBe('j');
  });

  // Check j has no triggering and no clean fixture, because it always lists its manual action
  // (docs/PRD.md:63): these tests check that it is listed, the same, whatever the repo holds.
  it('lists only its manual action on an empty directory', async () => {
    const findings = await run(await tempDir());
    expect(findings).toEqual(BACKUPS_MANUAL_CHECKS);
    expect(findings).toEqual([ENTRY]);
  });

  it('lists the same single entry on a repo with a supabase/config.toml and a sign-up call', async () => {
    expect(await run(await appRepo())).toEqual([ENTRY]);
  });

  it('gives no entry a severity', async () => {
    for (const root of [await tempDir(), await appRepo()]) {
      const findings = await run(root);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((f) => f.severity === undefined)).toBe(true);
    }
  });
});
