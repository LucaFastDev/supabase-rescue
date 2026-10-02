// Pins the flawed sample app: the audit of demo/ with --db on the demo stack finds exactly one
// finding with a severity for each check a to f, one review entry for the Reports route, and as
// manual entries only the dashboard auth checks. It reads only: the report goes to a temporary
// directory, and it creates nothing in the database.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { MANUAL_CHECKS } from '../src/checks/auth.ts';
import type { Finding } from '../src/findings.ts';
import { main } from '../src/main.ts';
import { isTestFixtureObject, testDbUrl } from './database.ts';
import { tempDir } from './repo.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

/** check, severity or kind, and the object or the file (without its line). */
const summary = (f: Finding) => [f.check, f.severity ?? f.kind, 'object' in f.location ? f.location.object : f.location.file];

describe('the audit of demo/, on the demo stack', () => {
  let code: number;
  let stderr: string;
  let findings: Finding[];

  beforeAll(async () => {
    const out = await tempDir();
    stderr = '';
    code = await main(['audit', 'demo', '--db', testDbUrl(), '--out', out], { cwd: root, stderr: (t) => (stderr += t) });
    const all: Finding[] = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8')).findings;
    findings = all.filter((f) => !('object' in f.location && isTestFixtureObject(f.location.object)));
  });

  it('runs, and exits 1 for the critical findings', () => {
    expect(stderr).toBe('');
    expect(code).toBe(1);
  });

  it('finds exactly one seeded flaw per check, at its severity, and nothing else with a severity', () => {
    expect(findings.filter((f) => f.severity !== undefined).map(summary)).toEqual([
      ['a', 'critical', 'public.staff_notes'],
      ['b', 'critical', 'public.appointments policy "Anyone can book an appointment"'],
      ['c', 'critical', 'public.appointments_for_phone(text)'],
      ['d', 'critical', 'src/integrations/supabase/admin.ts'],
      ['e', 'medium', 'supabase/config.toml'],
      ['f', 'low', 'supabase/migrations/20260915110000_staff_notes.sql'],
    ]);
  });

  it('reports the definer function with both of its problems, and the migration for its dropped column', () => {
    const c = findings.find((f) => f.check === 'c')!;
    expect(c.fix.snippet!.code).toContain('revoke execute on function public.appointments_for_phone(text) from anon, public;');
    expect(c.fix.snippet!.code).toContain("alter function public.appointments_for_phone(text) set search_path = '';");
    expect(findings.find((f) => f.check === 'f')!.title).toBe('Migration drops a column');
  });

  it('gives exactly one review entry, for the Reports route', () => {
    expect(findings.filter((f) => f.kind === 'review').map((f) => [...summary(f), f.title])).toEqual([
      ['e', 'review', 'src/App.tsx', 'Route /reports renders data without an auth check'],
    ]);
  });

  it('lists as manual actions only the dashboard auth checks', () => {
    const manual = findings.filter((f) => f.kind === 'manual');
    expect(manual.map((f) => f.title).sort()).toEqual(MANUAL_CHECKS.map((f) => f.title).sort());
  });
});

describe('isTestFixtureObject', () => {
  it('matches only the names test files make with randomName', () => {
    for (const object of ['test_0a1b2c3d4e5f.notes', 'test_0a1b2c3d4e5f.f(integer)', 'public.test_public_0a1b2c3d4e5f']) {
      expect(isTestFixtureObject(object), object).toBe(true);
    }
    for (const object of ['public.staff_notes', 'public.test_notes', 'public.test_public_0a1b2c3d4e5fx', 'test_schema.notes', 'api.test_0a1b2c3d4e5f']) {
      expect(isTestFixtureObject(object), object).toBe(false);
    }
  });
});

describe('the committed before report', () => {
  it.each(['report.md', 'report.json'])('%s names the target as demo and holds nothing from this machine or the connection string', async (file) => {
    const text = await readFile(path.join(root, 'case-study/before', file), 'utf8');
    const db = new URL(testDbUrl());
    if (file === 'report.json') expect(JSON.parse(text).target).toBe('demo');
    else expect(text).toContain('Target: `demo`.');
    expect(text).not.toContain(root.replace(/\/$/, ''));
    expect(text).not.toMatch(/\/(?:Users|home)\//);
    for (const part of [db.host, `${db.username}:${db.password}@`]) expect(text).not.toContain(part);
  });
});
