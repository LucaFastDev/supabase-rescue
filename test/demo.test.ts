// Pins the fixed sample app, which on main also carries check g's and check h's seeded flaws until
// the launch fixes land: the audit of demo/ with --db on the demo stack finds three findings with a
// severity, the critical for g, the high for h and the low for the column check f's migration
// dropped (an applied migration cannot be undone), no review entry, and as manual entries the dashboard auth checks plus one rotation of
// the service-role key the git history keeps. It also checks what the fixed policies let each
// role do, and the booking page's reference. It leaves nothing behind: the report goes to a
// temporary directory, and every statement run as a role is rolled back.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookingReference } from '../demo/src/lib/types.ts';
import { MANUAL_CHECKS } from '../src/checks/auth.ts';
import { CI_SCRIPT } from '../src/checks/migrations.ts';
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
  let all: Finding[];
  let findings: Finding[];

  beforeAll(async () => {
    const out = await tempDir();
    stderr = '';
    code = await main(['audit', 'demo', '--db', testDbUrl(), '--out', out], { cwd: root, stderr: (t) => (stderr += t) });
    all = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8')).findings;
    findings = all.filter((f) => !isFixture(f));
  });

  const isFixture = (f: Finding) => 'object' in f.location && isTestFixtureObject(f.location.object);

  it("runs, and exits 1 because of checks g and h's seeded flaws alone", () => {
    expect(stderr).toBe('');
    // Other test files, running at the same time, can have a fixture table without RLS in public,
    // which the audit sees as critical. Those, and check g's and check h's seeded flaws, are the
    // only findings allowed to raise the exit code.
    const raising = all.filter((f) => f.severity === 'critical' || f.severity === 'high');
    expect(raising.filter((f) => !isFixture(f)).map(summary)).toEqual([
      ['g', 'critical', 'supabase/functions/create-checkout/index.ts'],
      ['h', 'high', 'supabase/functions/summarise-weeks/index.ts'],
    ]);
    expect(code).toBe(raising.length === 0 ? 0 : 1);
  });

  it("finds the critical for check g's seeded flaw, the high for check h's and the low for the applied migration that dropped a column", () => {
    expect(findings.filter((f) => f.severity !== undefined).map(summary)).toEqual([
      ['g', 'critical', 'supabase/functions/create-checkout/index.ts'],
      ['h', 'high', 'supabase/functions/summarise-weeks/index.ts'],
      ['f', 'low', 'supabase/migrations/20260915110000_staff_notes.sql'],
    ]);
    expect(findings.find((f) => f.check === 'f')!.title).toBe('Migration drops a column');
    expect(findings.find((f) => f.check === 'g')!.title).toBe('Stripe charges an amount the browser sent');
    expect(findings.find((f) => f.check === 'h')!.title).toBe('Anyone can run up your OpenAI bill through the summarise-weeks edge function');
  });

  it('gives no review entry', () => {
    expect(findings.filter((f) => f.kind === 'review')).toEqual([]);
  });

  it('lists as manual actions the dashboard auth checks and one rotation of the key in the history', () => {
    const titles = findings.filter((f) => f.kind === 'manual').map((f) => f.title);
    const rotations = titles.filter((t) => t.startsWith('Rotate the'));
    expect(rotations).toHaveLength(1);
    expect(rotations[0]).toMatch(/^Rotate the Supabase service-role key .* found in the git history$/);
    expect(titles.filter((t) => !t.startsWith('Rotate the')).sort()).toEqual(MANUAL_CHECKS.map((f) => f.title).sort());
  });
});

// A seeded staff member (demo/supabase/seed.sql), and a signed-in user who is not staff.
const STAFF_ID = '6f1c2a3e-1d2b-4c5a-9e7f-0a1b2c3d4e01';
const NOT_STAFF_ID = '00000000-0000-4000-8000-000000000000';

describe('the fixed access rules, as each role sees them', () => {
  let client: pg.Client;
  /** Adds a note to a seeded customer, whose id is looked up here: most roles cannot read customers. */
  let addNote: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: testDbUrl() });
    await client.connect();
    const { rows } = await client.query("select id from public.customers where phone = '07700 900101'");
    addNote = `insert into public.staff_notes (customer_id, body) values ('${rows[0].id}', 'note')`;
  });

  afterAll(async () => {
    await client.end();
  });

  /**
   * Runs `sql` as the Data API would for `role`, signed in as `sub` when given, inside a
   * transaction that is always rolled back, so nothing is left in the database.
   */
  async function as(role: 'anon' | 'authenticated', sub: string | null, sql: string): Promise<pg.QueryResult> {
    await client.query('begin');
    try {
      await client.query(`set local role ${role}`);
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role, ...(sub && { sub }) })]);
      return await client.query(sql);
    } finally {
      await client.query('rollback');
    }
  }

  const booking = (startsAt: string, status?: string) =>
    `insert into public.appointments (id, customer_name, customer_phone, service, starts_at${status ? ', status' : ''})
     values (gen_random_uuid(), 'Test Visitor', '07700 900999', 'Blow-dry', ${startsAt}${status ? `, '${status}'` : ''})`;

  it('lets a visitor book a future appointment with the initial status, sending its own id', async () => {
    expect((await as('anon', null, booking("now() + interval '1 day'"))).rowCount).toBe(1);
  });

  it('refuses a visitor a booking in the past, or one with any status but booked', async () => {
    await expect(as('anon', null, booking("now() - interval '1 day'"))).rejects.toThrow(/row-level security/);
    for (const status of ['confirmed', 'completed', 'cancelled']) {
      await expect(as('anon', null, booking("now() + interval '1 day'", status)), status).rejects.toThrow(/row-level security/);
    }
  });

  it('gives a visitor no way to read, change or delete appointments', async () => {
    expect((await as('anon', null, 'select * from public.appointments')).rowCount).toBe(0);
    expect((await as('anon', null, "update public.appointments set status = 'cancelled'")).rowCount).toBe(0);
    expect((await as('anon', null, 'delete from public.appointments')).rowCount).toBe(0);
  });

  it('keeps staff notes from visitors and from signed-in users who are not staff', async () => {
    for (const [role, sub] of [['anon', null], ['authenticated', NOT_STAFF_ID]] as const) {
      expect((await as(role, sub, 'select * from public.staff_notes')).rowCount, role).toBe(0);
      expect((await as(role, sub, "update public.staff_notes set body = 'changed'")).rowCount, role).toBe(0);
      expect((await as(role, sub, 'delete from public.staff_notes')).rowCount, role).toBe(0);
      await expect(as(role, sub, addNote), role).rejects.toThrow(/row-level security/);
    }
  });

  it('lets staff read, add, change and delete staff notes', async () => {
    expect((await as('authenticated', STAFF_ID, 'select * from public.staff_notes')).rowCount).toBeGreaterThan(0);
    expect((await as('authenticated', STAFF_ID, addNote)).rowCount).toBe(1);
    expect((await as('authenticated', STAFF_ID, "update public.staff_notes set body = 'changed'")).rowCount).toBeGreaterThan(0);
    expect((await as('authenticated', STAFF_ID, 'delete from public.staff_notes')).rowCount).toBeGreaterThan(0);
  });

  it('lets staff read customers with their own session, as the Customers page now does', async () => {
    expect((await as('authenticated', STAFF_ID, 'select id, full_name, phone, email, created_at from public.customers')).rowCount).toBeGreaterThan(0);
  });

  it('has no appointments_for_phone function any more', async () => {
    const { rows } = await client.query("select to_regprocedure('public.appointments_for_phone(text)') as fn");
    expect(rows[0].fn).toBeNull();
  });
});

describe('the fixed booking page and staff app', () => {
  const source = (file: string) => readFile(path.join(root, 'demo/src', file), 'utf8');

  it('shows the first 8 characters of the appointment id, uppercased, as the booking reference', () => {
    expect(bookingReference('3f2a9c1e-7b4d-4e2a-9f10-0a1b2c3d4e5f')).toBe('3F2A9C1E');
  });

  it('books with an id made in the browser, reads nothing back, and has no phone lookup', async () => {
    const book = await source('pages/Book.tsx');
    expect(book).toContain('crypto.randomUUID()');
    expect(book).toContain('bookingReference(id)');
    expect(book).not.toContain('.select(');
    expect(book).not.toContain('appointments_for_phone');
    expect(book).not.toContain('Find my booking');
  });

  it('shows the same reference for each appointment in the staff list', async () => {
    expect(await source('pages/Appointments.tsx')).toContain('bookingReference(appointment.id)');
  });

  it('has no service-role client, and the Customers page uses the anon-key client', async () => {
    await expect(source('integrations/supabase/admin.ts')).rejects.toThrow(/ENOENT/);
    const customers = await source('pages/Customers.tsx');
    expect(customers).toContain('from "@/integrations/supabase/client"');
    expect(customers).not.toContain('supabaseAdmin');
  });

  it('runs the CI step check f suggests, word for word, on pull requests that add migrations', async () => {
    const workflow = await readFile(path.join(root, 'demo/.github/workflows/migrations-check.yml'), 'utf8');
    expect(workflow).toContain("paths: ['supabase/migrations/**']");
    expect(workflow).toContain(CI_SCRIPT.replace(/^(?=.)/gm, '          '));
  });

  it('keeps flaw comments only in the migrations that were already applied', async () => {
    for (const file of ['src/App.tsx', 'supabase/config.toml']) {
      expect(await readFile(path.join(root, 'demo', file), 'utf8'), file).not.toContain('FLAW');
    }
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

describe.each(['before', 'after'])('the committed %s report', (dir) => {
  it.each(['report.md', 'report.json'])('%s names the target as demo and holds nothing from this machine or the connection string', async (file) => {
    const text = await readFile(path.join(root, 'case-study', dir, file), 'utf8');
    const db = new URL(testDbUrl());
    if (file === 'report.json') expect(JSON.parse(text).target).toBe('demo');
    else expect(text).toContain('Target: `demo`.');
    expect(text).not.toContain(root.replace(/\/$/, ''));
    expect(text).not.toMatch(/\/(?:Users|home)\//);
    for (const part of [db.host, `${db.username}:${db.password}@`]) expect(text).not.toContain(part);
  });
});
