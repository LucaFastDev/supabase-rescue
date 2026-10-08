import { randomBytes } from 'node:crypto';
import os from 'node:os';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StoragePolicyRow } from '../src/catalog.ts';
import { NO_BUCKETS, appliesTo, isOpen, restrictingPolicies, storageCheck } from '../src/checks/storage.ts';
import type { Finding } from '../src/findings.ts';
import type { Fixture, StorageFixture } from './database.ts';
import { openFixture, randomName, storageFixture } from './database.ts';

// The demo's kind of policy: staff read only the files they uploaded.
const STAFF = 'exists (select 1 from public.staff s where s.user_id = (select auth.uid()))';
const ownerOnly = (id: string) =>
  `for select to authenticated using (bucket_id = '${id}' and owner_id = (select auth.uid())::text and ${STAFF})`;

const policy = (overrides: Partial<StoragePolicyRow>): StoragePolicyRow => ({
  name: 'p',
  permissive: 'PERMISSIVE',
  roles: ['public'],
  qual: null,
  ...overrides,
});

describe('which read policies apply to a bucket, and which are open', () => {
  it('applies a policy that names the bucket id as a literal, or does not mention bucket_id at all', () => {
    expect(appliesTo({ qual: "(bucket_id = 'photos'::text)" }, 'photos')).toBe(true);
    expect(appliesTo({ qual: "(bucket_id = ANY (ARRAY['avatars'::text, 'photos'::text]))" }, 'photos')).toBe(true);
    expect(appliesTo({ qual: null }, 'photos')).toBe(true);
    expect(appliesTo({ qual: 'true' }, 'photos')).toBe(true);
    expect(appliesTo({ qual: '(owner_id = (( SELECT auth.uid() AS uid))::text)' }, 'photos')).toBe(true);
  });

  it('does not apply a policy that names only other buckets, even one whose id contains this one', () => {
    expect(appliesTo({ qual: "(bucket_id = 'avatars'::text)" }, 'photos')).toBe(false);
    expect(appliesTo({ qual: "(bucket_id = 'customer-photos'::text)" }, 'photos')).toBe(false);
  });

  it('is open only when permissive, for public or both anon and authenticated, with no condition beyond the bucket', () => {
    for (const qual of [null, 'true', "(bucket_id = 'photos'::text)"]) {
      expect(isOpen(policy({ qual }), 'photos'), String(qual)).toBe(true);
      expect(isOpen(policy({ qual, roles: ['anon', 'authenticated'] }), 'photos'), String(qual)).toBe(true);
    }
  });

  it('counts as restricting a restrictive policy, one limited to authenticated or anon, and any other condition', () => {
    const restricting = [
      policy({ permissive: 'RESTRICTIVE', qual: 'true' }),
      policy({ roles: ['authenticated'], qual: "(bucket_id = 'photos'::text)" }),
      policy({ roles: ['anon'] }),
      policy({ qual: "((bucket_id = 'photos'::text) AND (owner_id = (( SELECT auth.uid() AS uid))::text))" }),
      policy({ qual: "(bucket_id = 'photos'::text) OR false" }),
    ];
    for (const p of restricting) expect(isOpen(p, 'photos'), JSON.stringify(p)).toBe(false);
    expect(restrictingPolicies('photos', restricting)).toEqual(restricting);
    expect(restrictingPolicies('photos', [policy({}), policy({ roles: ['authenticated'], qual: "(bucket_id = 'avatars'::text)" })])).toEqual([]);
  });
});

describe('check k on the demo stack', () => {
  let fx: Fixture;
  let store: StorageFixture;
  let hex: string;
  /** A bucket id or policy name for this test: test_<hex>, then the suffix. */
  const name = (suffix = '') => `test_${hex}${suffix}`;
  const at = (findings: Finding[], id: string) => findings.filter((f) => 'object' in f.location && f.location.object === `storage.buckets/${id}`);

  beforeAll(async () => {
    fx = await openFixture();
  });

  afterAll(async () => {
    await fx?.close();
  });

  /** Runs `body` with a fresh storage fixture, removed afterwards whatever happens. */
  async function withBuckets(body: () => Promise<void>): Promise<void> {
    hex = randomBytes(6).toString('hex');
    store = storageFixture(fx);
    try {
      await body();
    } finally {
      await store.remove();
    }
  }

  const run = async () => storageCheck.run(fx.context());

  it("reports a public bucket with the demo's kind of owner-only read policy as high", () =>
    withBuckets(async () => {
      await store.add(name(), true);
      await store.policy(name('_owner'), ownerOnly(name()));
      const findings = at(await run(), name());
      expect(findings).toHaveLength(1);
      const [finding] = findings;
      expect(finding).toMatchObject({
        check: 'k',
        severity: 'high',
        title: 'Public storage bucket with a read policy that does not protect its files',
        location: { object: `storage.buckets/${name()}` },
      });
      expect(finding!.why).toContain(`"${name('_owner')}"`);
      expect(finding!.why).toMatch(/anyone who has a file's URL/);
      expect(finding!.fix.text).toMatch(/private/);
      expect(finding!.fix.text).toMatch(/createSignedUrl/);
      expect(finding!.fix.snippet!.code).toContain(`update storage.buckets set public = false where id = '${name()}';`);
    }));

  it('reports a public bucket with a read policy limited to authenticated as high', () =>
    withBuckets(async () => {
      await store.add(name(), true);
      await store.policy(name('_signed_in'), `for select to authenticated using (bucket_id = '${name()}')`);
      const findings = at(await run(), name());
      expect(findings.map((f) => [f.severity, f.why.includes(`"${name('_signed_in')}"`)])).toEqual([['high', true]]);
    }));

  it('gives no finding for a public bucket with only an open read policy', () =>
    withBuckets(async () => {
      await store.add(name(), true);
      await store.policy(name('_open'), `for select to anon, authenticated using (bucket_id = '${name()}')`);
      expect(at(await run(), name())).toEqual([]);
    }));

  it('gives no finding for a public bucket with no read policy', () =>
    withBuckets(async () => {
      await store.add(name(), true);
      expect(at(await run(), name())).toEqual([]);
    }));

  it("gives no finding for a private bucket with a restricting read policy, the demo's fixed state", () =>
    withBuckets(async () => {
      await store.add(name(), false);
      await store.policy(name('_owner'), ownerOnly(name()));
      expect(at(await run(), name())).toEqual([]);
    }));

  it('does not apply to a bucket a policy whose condition names only another bucket', () =>
    withBuckets(async () => {
      await store.add(name(), true);
      await store.add(name('_other'), false);
      await store.policy(name('_other_owner'), ownerOnly(name('_other')));
      expect(at(await run(), name())).toEqual([]);
    }));

  it('gives one finding per bucket, naming each restricting policy, when two apply', () =>
    withBuckets(async () => {
      await store.add(name(), true);
      await store.policy(name('_owner'), ownerOnly(name()));
      await store.policy(name('_signed_in'), `for all to authenticated using (bucket_id = '${name()}')`);
      const findings = at(await run(), name());
      expect(findings).toHaveLength(1);
      expect(findings[0]!.why).toContain(`"${name('_owner')}", "${name('_signed_in')}"`);
    }));

  it('gives a review entry, not a crash and not silence, when the role may not read storage.buckets', () =>
    withBuckets(async () => {
      await store.add(name(), true);
      await store.policy(name('_owner'), ownerOnly(name()));
      const role = randomName('test_role');
      const password = randomName('pw');
      await fx.sql(`create role ${role} with login nosuperuser nobypassrls password '${password}'`);
      try {
        const url = new URL(fx.url);
        url.username = role;
        url.password = password;
        const context = { ...fx.context(), db: url.toString() };
        expect(await storageCheck.run(context)).toEqual([NO_BUCKETS]);
        expect(NO_BUCKETS).toMatchObject({ check: 'k', kind: 'review', title: 'Check k could not read the storage buckets' });
        expect(NO_BUCKETS.fix.text).toMatch(/current role-sql/);
      } finally {
        await fx.sql(`drop role if exists ${role}`);
      }
    }));
});

describe('check k without --db', () => {
  it('returns nothing and opens no connection', async () => {
    const connect = vi.spyOn(pg.Client.prototype, 'connect');
    try {
      expect(await storageCheck.run({ repoPath: os.tmpdir(), exposedSchemas: ['public'] })).toEqual([]);
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });
});
